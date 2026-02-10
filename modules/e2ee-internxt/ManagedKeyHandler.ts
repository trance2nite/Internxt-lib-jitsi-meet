/// <reference types="node" />

import JitsiConference from '../../JitsiConference';
import { JitsiConferenceEvents } from '../../JitsiConferenceEvents';
import JitsiParticipant from '../../JitsiParticipant';
import { RTCEvents } from '../../service/RTC/RTCEvents';
import JitsiLocalTrack from '../RTC/JitsiLocalTrack';
import TraceablePeerConnection from '../RTC/TraceablePeerConnection';
import browser from '../browser';
import Listenable from '../util/Listenable';
import JingleSessionPC from '../xmpp/JingleSessionPC';
import { FEATURE_E2EE, JITSI_MEET_MUC_TYPE } from '../xmpp/xmpp';

import { deriveSymmetricCryptoKeyFromTwoKeys, genSymmetricKey, hashChatKeys, hashData } from './CryptoUtils';
import E2EEContext from './E2EEContext';
import { OlmAdapter } from './OlmAdapter';
import { generateEmojiSas } from './SAS';
import {
    CryptoError,
    MediaKeys,
    MessageType,
    OLM_MESSAGE,
    OLM_MESSAGE_TYPES,
    ParticipantEvent,
    ReplyMessage,
} from './Types';


export const REQ_TIMEOUT = 20 * 1000;

function timeout<T>(ms: number): Promise<T> {
    return new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timed out')), ms),
    );
}

/**
 * This module integrates {@link E2EEContext} with {@link OlmAdapter} in order to distribute the keys for encryption.
 */
export class ManagedKeyHandler extends Listenable {
    private chatKeyECC: Uint8Array;
    private chatKeyPQ: Uint8Array;
    private askedForChatKey: boolean;
    private readonly myID: string;
    private readonly _participantEventQueue: ParticipantEvent[];
    private _processingEvents: boolean;
    private readonly _reqs: Map<
        string,
        { reject?: (args?: unknown) => void; resolve: (args?: unknown) => void; }
    >;

    private readonly update: Map<
        string,
        { reject?: (args?: unknown) => void; resolve: (args?: unknown) => void; }
    >;

    max_wait: number;
    conference: JitsiConference;
    e2eeCtx: E2EEContext;
    enabled: boolean;
    initialized: boolean;
    initSessions: Promise<unknown[]>;
    _olmAdapter: OlmAdapter;
    _conferenceJoined: boolean;

    /**
     * Build a new AutomaticKeyHandler instance, which will be used in a given conference.
     */
    constructor(conference: JitsiConference) {
        super();
        this.initialized = false;
        this.max_wait = REQ_TIMEOUT;
        this.conference = conference;
        this.myID = conference.myUserId();
        this.e2eeCtx = new E2EEContext();
        this._reqs = new Map();
        this.update = new Map();
        this.chatKeyECC = new Uint8Array();
        this.chatKeyPQ = new Uint8Array();
        this.askedForChatKey = false;

        this.enabled = false;
        this._participantEventQueue = [];
        this._processingEvents = false;

        this.conference.on(
            JitsiConferenceEvents.USER_JOINED,
            this._onParticipantJoined.bind(this),
        );
        this.conference.on(
            JitsiConferenceEvents.USER_LEFT,
            this._onParticipantLeft.bind(this),
        );
        this.conference.on(
            JitsiConferenceEvents.ENDPOINT_MESSAGE_RECEIVED,
            this._onEndpointMessageReceived.bind(this),
        );
        this.conference.on(
            JitsiConferenceEvents.CONFERENCE_LEFT,
            this._onConferenceLeft.bind(this),
        );
        this.conference.on(JitsiConferenceEvents.CONFERENCE_JOINED, () => {
            this._conferenceJoined = true;
        });
        this.conference.on(
            JitsiConferenceEvents._MEDIA_SESSION_STARTED,
            this._onMediaSessionStarted.bind(this),
        );
        this.conference.on(
            JitsiConferenceEvents.TRACK_ADDED,
            (track: JitsiLocalTrack) =>
                track.isLocal() && this._onLocalTrackAdded(track),
        );
        this.conference.rtc.on(
            RTCEvents.REMOTE_TRACK_ADDED,
            (track: JitsiLocalTrack, tpc: TraceablePeerConnection) =>
                this._setupReceiverE2EEForTrack(tpc, track),
        );
        this.conference.on(
            JitsiConferenceEvents.TRACK_MUTE_CHANGED,
            this._trackMuteChanged.bind(this),
        );

        this._conferenceJoined = false;

        this._olmAdapter = new OlmAdapter(this.myID);

        this.e2eeCtx.on('sasUpdated', (sasStr: string) => {
            const sas = generateEmojiSas(sasStr);

            this.log('info', `Emitting SAS: ${sas.join(', ')}`);
            this.conference.eventEmitter.emit(
                JitsiConferenceEvents.E2EE_SAS_AVAILABLE,
                sas,
            );
        });
    }

    private async init() {
        await this._olmAdapter.init();
        this.initialized = true;
    }

    /**
     * Setup E2EE on the new track that has been added to the conference, apply it on all the open peerconnections.
     * @param {JitsiLocalTrack} track - the new track that's being added to the conference.
     * @private
     */
    private _onLocalTrackAdded(track: JitsiLocalTrack) {
        for (const session of this.conference.getMediaSessions()) {
            this._setupSenderE2EEForTrack(session, track);
        }
    }

    /**
     * Setups E2E encryption for the new session.
     * @param {JingleSessionPC} session - the new media session.
     * @private
     */
    private _onMediaSessionStarted(session: JingleSessionPC) {
        const localTracks = this.conference.getLocalTracks();

        for (const track of localTracks) {
            this._setupSenderE2EEForTrack(session, track);
        }
    }

    private updateMyKeys() {
        const { olmKey, pqKey, index } = this._olmAdapter.updateMyKeys();

        this.setKey(olmKey, pqKey, index);
    }

    private async createKeyUpdatePromise(pId: string) {
        const promise = new Promise((resolve, reject) => {
            this.update.set(pId, { reject, resolve });
        });

        return Promise.race([ promise, timeout(this.max_wait) ]);
    }

    private async createSessionPromise(pId: string) {
        const promise = new Promise((resolve, reject) => {
            this._reqs.set(pId, { reject, resolve });
        });

        return Promise.race([ promise, timeout(this.max_wait) ]);
    }

    private resolveSessionPromise(pId: string) {
        const promise = this._reqs.get(pId);

        if (promise) {
            promise.resolve();
            this._reqs.delete(pId);
        }
    }

    private resolveAllSessionPromises() {
        for (const promise of this.update.values()) {
            promise?.resolve();
        }
        this._reqs.clear();
    }

    private resolveKeyUpdatePromise(pID: string) {
        const requestPromise = this.update.get(pID);

        if (requestPromise) {
            requestPromise.resolve();
            this.update.delete(pID);
        } else
            this.log(
                'warn',
                `Trying to resolve non-esistant key update with ${pID}.`,
            );
    }

    /**
     * Setup E2EE for the receiving side.
     *
     * @private
     */
    private _setupReceiverE2EEForTrack(
            tpc: TraceablePeerConnection,
            track: JitsiLocalTrack,
    ) {
        if (!this.enabled) {
            return;
        }

        const receiver = tpc.findReceiverForTrack(track.track);

        if (receiver) {
            this.e2eeCtx.handleReceiver(
                receiver,
                track.getParticipantId(),
            );
        } else {
            this.log(
                'warn',
                `Could not handle E2EE for ${track}: receiver not found in: ${tpc}`,
            );
        }
    }

    /**
     * Setup E2EE for the sending side.
     *
     * @param {JingleSessionPC} session - the session which sends the media produced by the track.
     * @param {JitsiLocalTrack} track - the local track for which e2e encoder will be configured.
     * @private
     */
    private _setupSenderE2EEForTrack(session: JingleSessionPC, track: JitsiLocalTrack) {
        if (!this.enabled) {
            return;
        }

        const pc = session.peerconnection;
        const sender = pc?.findSenderForTrack(track.track);

        if (sender) {
            this.e2eeCtx.handleSender(
                sender,
                track.getParticipantId(),
            );
        } else {
            this.log(
                'warn',
                `Could not handle E2EE for ${track}: sender not found in ${pc}`,
            );
        }
    }

    /**
     * Setup E2EE on the sender that is created for the unmuted local video track.
     * @param {JitsiLocalTrack} track - the track for which muted status has changed.
     * @private
     */
    private _trackMuteChanged(track: JitsiLocalTrack) {
        if (
            browser.doesVideoMuteByStreamRemove()
            && track.isLocal()
            && track.isVideoTrack()
            && !track.isMuted()
        ) {
            for (const session of this.conference.getMediaSessions()) {
                this._setupSenderE2EEForTrack(session, track);
            }
        }
    }

    /**
     * Advances (using ratcheting) the current key when a new participant joins the conference.
     *
     * @private
     */
    private async _handleParticipantJoined(id: string) {
        this.log('info', `Participant ${id} joined the conference.`);
        if (!this._conferenceJoined || !this.enabled) return;
        if (!this.initialized) {
            await this.init();
        }
        const participants = this.conference.getParticipants();
        const { olmKey, pqKey, index } = this._olmAdapter.ratchetMyKeys();

        this.setKey(olmKey, pqKey, index);
        for (const participant of participants) {
            const pId = participant.getId();

            if (this._olmAdapter.isSessionDone(pId)) {
                this.log('info', `Ratchted keys of user ${pId}.`);
                this.e2eeCtx.ratchetKeys(pId);
            }
        }
    }

    /**
     * Rotates the current key when a participant leaves the conference.
     * @private
     */
    private async _handleParticipantLeft(id: string) {
        this.log('info', `Participant ${id} left the conference.`);

        if (!this.enabled) return;
        if (!this.initialized) {
            await this.init();
        }

        this.resolveSessionPromise(id);
        if (this.update.get(id)) this.resolveKeyUpdatePromise(id);
        this.updateMyKeys();
        const participants = this.conference.getParticipants();
        const updateBatch = participants.map(async participant => {
            const pId = participant.getId();

            try {
                if (this._olmAdapter.isSessionDone(pId)) {
                    this.log('info', `Sending key update to ${pId}.`);
                    const result = this.createKeyUpdatePromise(pId);
                    const data = await this._olmAdapter.encryptCurrentKey(pId);

                    this._sendMessage(OLM_MESSAGE_TYPES.KEY_UPDATE, data, pId);
                    this.log(
                        'info',
                        `Key update with ${pId} finished successfully.`,
                    );

                    return await result;
                }
            } catch (error) {
                this.log(
                    'warn',
                    `Key update request timed out for ${pId}: ${error}`,
                );
                this.log('info', 'Explicitly requesting new current key.');
                try {
                    const result = this.createKeyUpdatePromise(pId);

                    this._sendMessage(
                        OLM_MESSAGE_TYPES.KEY_UPDATE_REQ,
                        'update',
                        pId,
                    );
                    this.log(
                        'info',
                        `Key update with ${pId} finished successfully.`,
                    );

                    return await result;
                } catch (err) {
                    this.log(
                        'error',
                        `Explicit key update request timed out for ${pId}: ${err}`,
                    );
                }
            }
        });

        await Promise.allSettled(updateBatch);
    }

    private clearAllSessions() {
        this.resolveAllSessionPromises();
        const participants = this.conference.getParticipants();

        for (const participant of participants) {
            this._olmAdapter.deleteParticipantSession(participant.getId());
        }
    }

    private _onConferenceLeft() {
        this.clearAllSessions();
        this._olmAdapter.clearMySession();
    }

    private async updateKey(pId: string, ciphertext: string, pqCiphertext: string) {
        try {
            const key = await this._olmAdapter.decryptKey(
                pId,
                ciphertext,
                pqCiphertext,
            );

            this.updateParticipantKey(pId, key);
        } catch (error) {
            throw new Error(
                `updateParticipantKey failed for participant ${pId}: ${error}`,
            );
        }
    }

    private isThisParticipantFirst(pId: string): boolean {
        const localParticipantId = this.myID;
        const participants = this.conference.getParticipants();
        const list = participants.filter(
            participant =>
                (participant.hasFeature(FEATURE_E2EE)
                || participant.getProperty('e2ee.enabled') === 'true')
                && localParticipantId > participant.getId(),
        );

        if (list.length === 0) return false;
        const firstParticipant = list[0].getId();

        return firstParticipant === pId;
    }

    private async _onEndpointMessageReceived(participant: JitsiParticipant, payload) {
        try {
            if (
                !payload.olm
                || payload[JITSI_MEET_MUC_TYPE] !== OLM_MESSAGE
            ) {
                this.log('error', 'Incorrect payload');

                return;
            }
            if (!this.initialized) {
                throw new Error('Not initialized');
            }

            const msg = payload.olm;
            const pId = participant.getId();

            switch (msg.type) {
            case OLM_MESSAGE_TYPES.SESSION_INIT: {
                this.log('info', `Got session-init from ${pId}.`);
                const { otKey, publicKey, publicKyberKey, commitment }
                        = msg.data;
                const data
                        = await this._olmAdapter.createPQsessionInitMessage(
                            pId,
                            otKey,
                            publicKey,
                            publicKyberKey,
                            commitment,
                        );

                this.setKeyCommitment(pId, publicKey, publicKyberKey);
                this._sendMessage(
                        OLM_MESSAGE_TYPES.PQ_SESSION_INIT,
                        data,
                        pId,
                );
                break;
            }

            case OLM_MESSAGE_TYPES.PQ_SESSION_INIT: {
                this.log('info', `Got pq-session-init from ${pId}.`);
                const {
                    encapsKyber,
                    publicKey,
                    publicKyberKey,
                    ciphertext,
                } = msg.data;
                const data
                        = await this._olmAdapter.createPQsessionAckMessage(
                            pId,
                            encapsKyber,
                            publicKey,
                            publicKyberKey,
                            ciphertext,
                        );

                this.setKeyCommitment(pId, publicKey, publicKyberKey);
                this._sendMessage(
                        OLM_MESSAGE_TYPES.PQ_SESSION_ACK,
                        data,
                        pId,
                );
                break;
            }
            case OLM_MESSAGE_TYPES.PQ_SESSION_ACK: {
                this.log('info', `Got pq-session-ack from ${pId}.`);
                const { encapsKyber, ciphertext, pqCiphertext } = msg.data;

                const { data, key }
                        = await this._olmAdapter.createSessionAckMessage(
                            pId,
                            encapsKyber,
                            ciphertext,
                            pqCiphertext,
                        );

                this.updateParticipantKey(pId, key);
                this._sendMessage(OLM_MESSAGE_TYPES.SESSION_ACK, data, pId);
                break;
            }
            case OLM_MESSAGE_TYPES.SESSION_ACK: {
                this.log('info', `Got session-ack from ${pId}.`);
                const { ciphertext, pqCiphertext } = msg.data;
                const { keyChanged, key }
                        = await this._olmAdapter.createSessionDoneMessage(
                            pId,
                            ciphertext,
                            pqCiphertext,
                        );

                this.updateParticipantKey(pId, key);
                this._sendMessage(
                        OLM_MESSAGE_TYPES.SESSION_DONE,
                        'done',
                        pId,
                );

                if (!this.askedForChatKey && this.isThisParticipantFirst(pId)) {
                    this.log('info', `Requesting chat key from ${pId}.`);
                    this._sendMessage(
                        OLM_MESSAGE_TYPES.CHAT_KEY_REQUEST,
                        'chat',
                        pId,
                    );
                    this.askedForChatKey = true;
                }
                if (keyChanged) {
                    const data
                            = await this._olmAdapter.encryptCurrentKey(pId);

                    this._sendMessage(
                            OLM_MESSAGE_TYPES.KEY_INFO,
                            data,
                            pId,
                    );
                }
                const requestPromise = this._reqs.get(pId);

                if (requestPromise) {
                    requestPromise.resolve();
                    this._reqs.delete(pId);
                } else {
                    const user = { name: participant.getDisplayName(), pId };

                    this.conference.eventEmitter.emit(
                        JitsiConferenceEvents.E2EE_KEY_SYNC_AFTER_TIMEOUT, user);
                    this.log(
                            'warn',
                            `Session with ${pId} (${user.name}) was established after reaching time out.`,
                    );
                }
                break;
            }
            case OLM_MESSAGE_TYPES.ERROR: {
                this.log('error', msg.data.error);
                break;
            }
            case OLM_MESSAGE_TYPES.SESSION_DONE: {
                this.log('info', `Got session-done from ${pId}.`);
                const keyChanged
                        = this._olmAdapter.processSessionDoneMessage(pId);

                if (keyChanged) {
                    const data
                            = await this._olmAdapter.encryptCurrentKey(pId);

                    this._sendMessage(
                            OLM_MESSAGE_TYPES.KEY_INFO,
                            data,
                            pId,
                    );
                }
                this.log(
                        'info',
                        `Participant ${pId} established E2E channel with us.`,
                );
                break;
            }
            case OLM_MESSAGE_TYPES.KEY_INFO: {
                this.log('info', `Got key-info from ${pId}.`);
                const { ciphertext, pqCiphertext } = msg.data;

                await this.updateKey(pId, ciphertext, pqCiphertext);
                break;
            }
            case OLM_MESSAGE_TYPES.KEY_UPDATE: {
                this.log('info', `Got key-update from ${pId}.`);
                const { ciphertext, pqCiphertext } = msg.data;

                await this.updateKey(pId, ciphertext, pqCiphertext);
                this.resolveKeyUpdatePromise(pId);
                break;
            }
            case OLM_MESSAGE_TYPES.KEY_UPDATE_REQ: {
                this.log('info', `Got key-update-req from ${pId}.`);
                const data = await this._olmAdapter.encryptCurrentKey(pId);

                this._sendMessage(OLM_MESSAGE_TYPES.KEY_UPDATE, data, pId);
                break;
            }
            case OLM_MESSAGE_TYPES.CHAT_KEY: {
                this.log('info', `Got chat key from ${pId}. `);
                const { ciphertext, pqCiphertext } = msg.data;
                const { keyECC, keyPQ } = await this._olmAdapter.decryptChatKey(pId, ciphertext, pqCiphertext);

                this.setMyChatKey(keyECC, keyPQ);
                break;
            }
            case OLM_MESSAGE_TYPES.CHAT_KEY_REQUEST: {
                this.log('info', `Got chat key request from ${pId}.`);
                const data = await this._olmAdapter.encryptChatKey(pId, this.chatKeyECC, this.chatKeyPQ);

                this._sendMessage(OLM_MESSAGE_TYPES.CHAT_KEY, data, pId);
                break;
            }
            }
        } catch (error) {
            this.log('error', `Error while processing message: ${error}`);
            const user = { name: participant.getDisplayName(), pId: participant.getId() };

            if (error instanceof CryptoError) {
                this.log('error', `Crypto error occured: ${error}`);
                this.conference.eventEmitter.emit(
                JitsiConferenceEvents.E2EE_CRYPTO_FAILED, user);
                this.log(
                    'error',
                    `Processing message from user ID ${user.pId} (${user.name}) failed due to a crypto error: ${error}`,
                );
            }
        }
    }

    private setKeyCommitment(pId: string, publicKey: string, publicKyberKey: string) {
        const keyCommitment = hashData([ pId, publicKey, publicKyberKey ]);

        this.e2eeCtx.setKeysCommitment(
            pId,
            keyCommitment,
        );
    }

    private setMyChatKey(keyECC: Uint8Array, keyPQ: Uint8Array) {
        const chatKeyHash = hashChatKeys(keyECC, keyPQ);

        this.e2eeCtx.setChatKeyHash(
            chatKeyHash,
        );
        this.chatKeyECC = keyECC;
        this.chatKeyPQ = keyPQ;
        const key = deriveSymmetricCryptoKeyFromTwoKeys(keyECC, keyPQ);

        this.conference.eventEmitter.emit(JitsiConferenceEvents.E2EE_CHAT_KEY_RECEIVED, key);
        this.log('info', 'Set chat key hash and emit key to the ChatRoom module.');
    }

    /**
     * Updates a participant's key.
     *
     * @param {string} id - The participant ID.
     * @param {MediaKey} key - The new key of the participant.
     */
    private updateParticipantKey(id: string, key: MediaKeys) {
        this.e2eeCtx.setKey(id, key.olmKey, key.pqKey, key.index);
    }

    /**
     * Sends the given object to the given participant ID via XMPP MUC private messages.
     *
     * @param {MessageType} type - The message type.
     * @param {ReplyMessage} data - The message data.
     * @param {string} participantId - The target participant ID.
     */
    private _sendMessage(
            type: MessageType,
            data: ReplyMessage | 'update' | 'done' | 'chat',
            participantId: string,
    ) {
        const msg = {
            [JITSI_MEET_MUC_TYPE]: OLM_MESSAGE,
            olm: {
                data,
                type,
            },
        };

        this.conference.sendMessage(msg, participantId);
    }

    private _queueParticipantEvent(type: 'join' | 'leave', id: string) {
        this._participantEventQueue.push({
            id,
            type,

        });

        if (!this._processingEvents) {
            this._processParticipantEvents();
        }
    }

    private async _processParticipantEvents() {
        if (this._processingEvents) {
            return;
        }

        this._processingEvents = true;

        try {
            while (this._participantEventQueue.length > 0) {
                const event = this._participantEventQueue.shift();

                if (event?.type === 'join') {
                    await this._handleParticipantJoined(event.id);
                } else if (event?.type === 'leave') {
                    await this._handleParticipantLeft(event.id);
                    this.e2eeCtx.cleanup(event.id);
                }
            }
        } finally {
            this._processingEvents = false;
        }
    }

    private log(level: 'info' | 'error' | 'warn', message: string) {
        console[level](`E2E: User ${this.myID}: ${message}`);
    }

    _onParticipantJoined(id: string) {
        this._queueParticipantEvent('join', id);
    }

    _onParticipantLeft(id: string) {
        if (this.enabled && this.initialized) {
            this._olmAdapter.clearParticipantSession(id);
            if (this.update.get(id)) this.resolveKeyUpdatePromise(id);
        }

        this._queueParticipantEvent('leave', id);
    }

    /**
     * Set the keys of the current participant.
     * @param {Uint8Array} olmKey - The olm key.
     * @param {Uint8Array} pqKey - The pq key.
     * @param {number} index - The keys index.
     */
    setKey(olmKey: Uint8Array, pqKey: Uint8Array, index: number) {
        this.e2eeCtx.setKey(this.myID, olmKey, pqKey, index);
    }

    /**
     * Indicates whether E2EE is currently enabled or not.
     *
     * @returns {boolean}
     */
    isEnabled() {
        return this.enabled;
    }

    /**
     * Enables End-To-End encryption.
     */
    async enableE2E() {
        const localParticipantId = this.myID;
        const { pkKyber, pk } = this._olmAdapter.genMyPublicKeys();

        this.setKeyCommitment(localParticipantId, pk, pkKyber);
        this.updateMyKeys();

        const participants = this.conference.getParticipants();

        this.log(
            'info',
            `There are following IDs in the meeting: [ ${participants.map(p => `${p.getId()}`).join(', ')}]`,
        );
        const list = participants.filter(
            participant =>
                (participant.hasFeature(FEATURE_E2EE)
                || participant.getProperty('e2ee.enabled') === 'true')
                && localParticipantId > participant.getId(),
        );
        const keys = this._olmAdapter.generateOneTimeKeys(list.length);

        this.log(
            'info',
            `Should send session-init to IDs: [ ${list.map(p => p.getId())}]`,
        );

        if (!this.askedForChatKey && list.length == 0) {
            this.log('info', 'Generated chat keys');
            const chatKeyECC = genSymmetricKey();
            const chatKeyPQ = genSymmetricKey();

            this.askedForChatKey = true;
            this.setMyChatKey(chatKeyECC, chatKeyPQ);
        }

        this.initSessions = (async () => {
            const promises = list.map(async participant => {
                const pId = participant.getId();

                try {
                    const lastKey = keys.pop();

                    if (!lastKey) throw new Error('No one time keys');
                    const data
                        = await this._olmAdapter.createSessionInitMessage(
                            pId,
                            lastKey,
                        );

                    this.log('info', `Sent session-init to participant ${pId}`);
                    this._sendMessage(
                        OLM_MESSAGE_TYPES.SESSION_INIT,
                        data,
                        pId,
                    );

                    const result = await this.createSessionPromise(pId);

                    this.log(
                        'info',
                        `Session with ${pId} initialized successfully.`,
                    );

                    return result;
                } catch (error) {
                    const user = { name: participant.getDisplayName(), pId };

                    if (error instanceof CryptoError) {
                        this.log('error', `Crypto error occured: ${error}`);
                        this.conference.eventEmitter.emit(
                JitsiConferenceEvents.E2EE_CRYPTO_FAILED, user);
                        this.log(
                        'error',
                        `Session initialization request with user with ID ${pId} (${user.name}) failed due to a crypto error: ${error}`,
                        );
                    } else {

                        this.conference.eventEmitter.emit(
                JitsiConferenceEvents.E2EE_KEY_SYNC_FAILED, user);
                        this.log(
                        'error',
                        `Session initialization request timed out for user with ID ${pId} (${user.name}): ${error}`,
                        );
                    }
                }
            });

            return Promise.all(promises);
        })();
        await this.initSessions;
    }

    /**
     * Disables End-To-End encryption.
     */
    async disableE2E() {
        this.e2eeCtx.cleanupAll();
        this.clearAllSessions();
    }

    /**
     * Enables / disables End-To-End encryption.
     *
     * @param {boolean} enabled - whether E2EE should be enabled or not.
     * @returns {void}
     */
    async setEnabled(enabled: boolean) {
        if (enabled === this.enabled) {
            return;
        }
        this.enabled = enabled;

        if (!this.initialized) {
            await this.init();
        }

        if (enabled) {
            this.log('info', 'Enabling e2ee');
            await this.enableE2E();
        }

        if (!enabled) {
            this.log('info', 'Disabling e2ee');
            await this.disableE2E();
        }

        this.conference.setLocalParticipantProperty('e2ee.enabled', enabled.toString());
        this.conference.restartMediaSessions();
    }

    async messageReceived(participant: JitsiParticipant, payload) {
        if (!participant) {
            this.log('error', 'Got message from an unknown participant');

            return;
        }
        this._onEndpointMessageReceived(participant, payload);
    }

    leaveConference() {
        this._onConferenceLeft();
    }
}
