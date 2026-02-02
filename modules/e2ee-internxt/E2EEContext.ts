/* global RTCRtpScriptTransform */
import { getLogger } from '@jitsi/logger';

import Listenable from '../util/Listenable';

const logger = getLogger('modules/e2ee-internxt/E2EEContext');

/**
 * Context encapsulating the cryptography bits required for E2EE.
 * This uses the WebRTC Insertable Streams API which is explained in
 *   https://github.com/alvestrand/webrtc-media-streams/blob/master/explainer.md
 * that provides access to the encoded frames and allows them to be transformed.
 *
 */
export default class E2EEcontext extends Listenable {
    private readonly _worker: Worker;
    private _workerUrl: string | null = null;

    constructor() {
        super();
        this._worker = this._initializeWorker();

        this._worker.onerror = e => logger.error(e);

        this._worker.onmessage = (event: MessageEvent) => {
            const { operation, sas } = event.data;

            if (operation === 'updateSAS' && sas) {
                this.updateSAS(sas);
            }
        };
    }

    private _initializeWorker(): Worker {
        const scriptEl = document.querySelector<HTMLScriptElement>(
            'script[src*="lib-jitsi-meet"]',
        );
        let baseUrl = '';

        if (scriptEl) {
            const idx = scriptEl.src.lastIndexOf('/');

            baseUrl = `${scriptEl.src.substring(0, idx)}/`;
        }

        let workerUrl = `${baseUrl}lib-jitsi-meet.e2ee-worker.js`;

        if (baseUrl && baseUrl !== '/') {
            const workerBlob = new Blob([ `importScripts("${workerUrl}");` ], {
                type: 'application/javascript',
            });

            workerUrl = URL.createObjectURL(workerBlob);
            this._workerUrl = workerUrl;
        }

        return new Worker(workerUrl, { name: 'E2EE Worker' });
    }

    private async updateSAS(sas: string[]) {
        this.emit('sasUpdated', sas);
    }

    /**
     * Disposes of the worker and cleans up resources.
     */
    dispose() {
        logger.info('E2EE: Disposing E2EE context and terminating worker');

        this.cleanupAll();
        this._worker.terminate();
        if (this._workerUrl) {
            URL.revokeObjectURL(this._workerUrl);
            this._workerUrl = null;
        }
    }

    cleanup(participantId: string) {
        this._worker.postMessage({
            operation: 'cleanup',
            participantId,
        });
    }

    cleanupAll() {
        this._worker.postMessage({
            operation: 'cleanupAll',
        });
    }

    /**
     * Handles the given {@code RTCRtpReceiver} by creating a {@code TransformStream} which will inject
     * a frame decoder.
     *
     * @param {RTCRtpReceiver} receiver - The receiver which will get the decoding function injected.
     * @param {string} participantId - The participant id that this receiver belongs to.
     */
    handleReceiver(receiver: RTCRtpReceiver, participantId: string) {
        if (receiver.kJitsiE2EE) return;
        receiver.kJitsiE2EE = true;

        const options = {
            operation: 'decode',
            participantId,
        };

        if (window.RTCRtpScriptTransform) {
            receiver.transform = new RTCRtpScriptTransform(
                this._worker,
                options,
            );
        } else if (receiver.createEncodedStreams) {
            const { readable, writable } = receiver.createEncodedStreams();

            this._worker.postMessage(
                {
                    ...options,
                    readableStream: readable,
                    writableStream: writable,
                },
                [ readable, writable ],
            );
        } else logger.error('Receiver does not support encoded streams.!');
    }

    /**
     * Handles the given {@code RTCRtpSender} by creating a {@code TransformStream} which will inject
     * a frame encoder.
     *
     * @param {RTCRtpSender} sender - The sender which will get the encoding function injected.
     * @param {string} participantId - The participant id that this sender belongs to.
     */
    handleSender(sender: RTCRtpSender, participantId: string) {
        if (sender.kJitsiE2EE) return;
        sender.kJitsiE2EE = true;

        const options = {
            operation: 'encode',
            participantId,
        };

        if (window.RTCRtpScriptTransform) {
            sender.transform = new RTCRtpScriptTransform(this._worker, options);
        } else if (sender.createEncodedStreams) {
            const { readable, writable } = sender.createEncodedStreams();

            this._worker.postMessage(
                {
                    ...options,
                    readableStream: readable,
                    writableStream: writable,
                },
                [ readable, writable ],
            );
        } else logger.error('Sender does not support encoded streams.');
    }

    setKey(
            participantId: string,
            olmKey: Uint8Array,
            pqKey: Uint8Array,
            index: number,
    ) {
        this._worker.postMessage({
            index,
            olmKey,
            operation: 'setKey',
            participantId,
            pqKey,
        });
    }

    setKeysCommitment(participantId: string, commitment: Uint8Array) {
        this._worker.postMessage({
            commitment,
            operation: 'setKeysCommitment',
            participantId,
        });
    }

    setChatKeyHash(chatKeyHash: Uint8Array) {
        this._worker.postMessage({
            chatKeyHash,
            operation: 'setChatKeyHash',
        });
    }

    ratchetKeys(participantId: string) {
        this._worker.postMessage({
            operation: 'ratchetKeys',
            participantId,
        });
    }

}
