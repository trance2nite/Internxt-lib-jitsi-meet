import JitsiConference from '../../JitsiConference';
import browser from '../browser';

import { ManagedKeyHandler } from './ManagedKeyHandler';

/**
 * This module integrates {@link ManagedKeyHandler} with {@link JitsiConference} in order to enable E2E encryption.
 */
export class E2EEncryption {
    private readonly _keyHandler: ManagedKeyHandler;
    /**
     * A constructor.
     * @param {JitsiConference} conference - The conference instance for which E2E encryption is to be enabled.
     */
    constructor(conference: JitsiConference) {
        this._keyHandler = new ManagedKeyHandler(conference);
    }

    /**
     * Indicates if E2EE is supported in the current platform.
     *
     * @param {object} config - Global configuration.
     * @returns {boolean}
     */
    static isSupported(config) {
        if (config.e2ee?.disabled || config.testing?.disableE2EE) {
            return false;
        }

        return (
            browser.supportsInsertableStreams()
            || (config.enableEncodedTransformSupport
                && browser.supportsEncodedTransform())
        );
    }

    /**
     * Indicates whether E2EE is currently enabled or not.
     *
     * @returns {boolean}
     */
    isEnabled() {
        return this._keyHandler.isEnabled();
    }

    dispose() {
        this._keyHandler.dispose();
    }

    /**
     * Enables / disables End-To-End encryption.
     *
     * @param {boolean} enabled - whether E2EE should be enabled or not.
     * @returns {void}
     */
    async setEnabled(enabled: boolean): Promise<void> {
        await this._keyHandler.setEnabled(enabled);
    }

    /**
     * Sets keys and index for End-to-End encryption.
     *
     * @param {Uint8Array} olmKey - The olm key.
     * @param {Uint8Array} pqKey - The pq key.
     * @param {number} index - The index of the encryption key.
     * @returns {void}
     */
    setEncryptionKey(olmKey: Uint8Array, pqKey: Uint8Array, index: number) {
        this._keyHandler.setKey(olmKey, pqKey, index);
    }
}
