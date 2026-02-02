import { anything, instance, mock, when } from 'ts-mockito';

import JitsiConference from '../JitsiConference';
import { JitsiConferenceEvents } from '../JitsiConferenceEvents';
import JitsiParticipant from '../JitsiParticipant';
import RTC from '../modules/RTC/RTC';
import { ManagedKeyHandler } from '../modules/e2ee-internxt/ManagedKeyHandler';
import { setupWorker } from '../modules/e2ee-internxt/Worker';
import EventEmitter from '../modules/util/EventEmitter';


export function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class WorkerMock {
    private readonly _fakeWorkerSelf: {
        onmessage: ((event: MessageEvent) => void) | null;
        postMessage: (data: any) => void;
    };

    public onmessage: ((event: MessageEvent) => void) | null = null;
    public onerror: ((event: Event) => void) | null = null;

    constructor(_scriptUrl: string, _options?: WorkerOptions) {
        this._fakeWorkerSelf = {
            onmessage: null,
            postMessage: (data: any) => {
                setTimeout(() => {
                    this.onmessage?.({ data } as MessageEvent);
                }, 0);
            },
        };
        (globalThis as any).self = this._fakeWorkerSelf;
        const originalSelf = globalThis.self;

        setupWorker(this._fakeWorkerSelf);
        (globalThis as any).self = originalSelf;
    }

    postMessage(data: any) {
        this._fakeWorkerSelf.onmessage?.({ data } as MessageEvent);
    }

    terminate() {
        this.onmessage = null;
        this.onerror = null;
        this._fakeWorkerSelf.onmessage = null;
    }
}

export class XmppServerMock {
    private readonly listeners = new Map<string, ManagedKeyHandler>();
    private readonly participants = new Map<string, JitsiParticipant>();
    private readonly sasMap = new Map<string, string[]>();
    private e2e: boolean = false;
    private moderatorId: string | null = null;

    createMockParticipant(participantId: string): JitsiParticipant {
        const mockParticipant = mock(JitsiParticipant);

        when(mockParticipant.getId()).thenReturn(participantId);
        when(mockParticipant.hasFeature(anything())).thenReturn(true);
        when(mockParticipant.isModerator()).thenCall(() => this.moderatorId === participantId);
        when(mockParticipant.getRole()).thenCall(() => this.moderatorId === participantId ? 'moderator' : 'none');
        const participant = instance(mockParticipant);

        return participant;
    }

    setSas(id: string, sas: string[]) {
        this.sasMap.set(id, sas);
    }

    getSas(id: string): string[] {
        return this.sasMap.get(id) ?? [];
    }

    getAllParticipantsIDs(): string[] {
        return [ ...this.participants.keys() ];
    }

    isParticipantModerator(participantId: string): boolean {
        return this.moderatorId === participantId;
    }

    getParticipantsFor(id: string): JitsiParticipant[] {
        const list: JitsiParticipant[] = [];

        this.participants.forEach((participant, pId) => {
            if (id !== pId) {
                list.push(participant);
            }
        });

        return list;
    }

    enableE2E() {
        this.e2e = true;
        for (const [ _, keyHandler ] of this.listeners) {
            keyHandler.setEnabled(true);
        }
    }

    disableE2E() {
        this.e2e = false;
        this.listeners.forEach((keyHandler, _id) => {
            keyHandler.setEnabled(false);
        });
    }

    userJoined(keyHandler: ManagedKeyHandler) {
        keyHandler.setEnabled(this.e2e);

        const pId = keyHandler.conference.myUserId();

        if (!this.listeners.has(pId)) {
            this.listeners.forEach((existingHandler, _id) => {
                existingHandler._onParticipantJoined(pId);
            });
            this.listeners.set(pId, keyHandler);

            const isFirst = this.listeners.size === 1;

            if (isFirst) {
                this.moderatorId = pId;
            }

            const participant = this.createMockParticipant(pId);

            this.participants.set(pId, participant);
        }
    }

    userLeft(pId: string) {
        const leftUser = this.listeners.get(pId);

        leftUser?.leaveConference();

        this.participants.delete(pId);
        this.listeners.delete(pId);

        if (this.moderatorId === pId && this.listeners.size > 0) {
            this.moderatorId = this.listeners.keys().next().value ?? null;
        }

        this.listeners.forEach((keyHandler, _id) => {
            keyHandler._onParticipantLeft(pId);
        });
    }

    sendMessage(myId: string, pId: string, payload: any) {
        this.listeners.forEach((keyHandler, id) => {
            if (id === pId) {
                keyHandler.messageReceived(
                    this.participants.get(myId),
                    payload,
                );
            }
        });
    }
}

export async function createInitializedManagedKeyHandler(
        xmppServerMock: XmppServerMock,
        max_timeout: number,
): Promise<{
            id: string;
            keyHandler: ManagedKeyHandler;
        }> {
    const id = new Date().getTime().toString(16).slice(-8);

    const conferenceMock = mock<JitsiConference>();

    when(conferenceMock.myUserId()).thenReturn(id);

    const mockRTC = new RTC(conferenceMock);

    when(conferenceMock.rtc).thenReturn(mockRTC);

    const eventEmitterMock = mock<EventEmitter>();

    when(eventEmitterMock.emit(anything(), anything())).thenCall(
        (event, sas) => {
            if (event === JitsiConferenceEvents.E2EE_SAS_AVAILABLE) {
                xmppServerMock.setSas(id, sas);
            }
        },
    );

    // eslint-disable-next-line prefer-const
    let keyHandler: ManagedKeyHandler;

    when(eventEmitterMock.emit(anything())).thenCall(event => {
        if (event === JitsiConferenceEvents.CONFERENCE_JOINED) {
            keyHandler._conferenceJoined = true;
            keyHandler.max_wait = max_timeout;
        }
    });

    when(conferenceMock.eventEmitter).thenReturn(instance(eventEmitterMock));

    const eventHandlers = new Map<string, ((...args: any[]) => void)[]>();

    when(conferenceMock.on(anything(), anything())).thenCall(
        (eventName, handler) => {
            if (!eventHandlers.has(eventName)) {
                eventHandlers.set(eventName, []);
            }
            eventHandlers.get(eventName)?.push(handler);

            return conferenceMock;
        },
    );
    when(conferenceMock.getParticipants()).thenCall(() => {
        return xmppServerMock.getParticipantsFor(id);
    });

    when(conferenceMock.isModerator()).thenCall(() => {
        return xmppServerMock.isParticipantModerator(id);
    });

    when(conferenceMock.sendMessage(anything(), anything())).thenCall(
        (payload, pId) => {
            xmppServerMock.sendMessage(id, pId, payload);
        },
    );

    const conference = instance(conferenceMock);

    keyHandler = new ManagedKeyHandler(conference);

    conference.eventEmitter.emit(JitsiConferenceEvents.CONFERENCE_JOINED);

    return { id, keyHandler };
}
