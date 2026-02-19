import { XMPPEvents } from '../service/xmpp/XMPPEvents';
import ChatRoom from '../modules/xmpp/ChatRoom';
import Moderator from '../modules/xmpp/moderator';
import XMPP from '../modules/xmpp/xmpp';
import XmppConnection from '../modules/xmpp/XmppConnection';
import { genSymmetricKey } from '../modules/e2ee-internxt/CryptoUtils';
import { decryptSymmetricallySync, encryptSymmetricallySync } from '../modules/xmpp/ChetRoomCrypto';

// Mock XMPP interface for tests
interface IMockXMPP {
    moderator: Moderator;
    options: Record<string, any>;
    addListener: () => void;
}

// Jasmine types for spies
declare let spyOn: (object: any, method: string) => jasmine.Spy;

// This rule makes creating the xml elements take up way more
// space than necessary.
/* eslint-disable newline-per-chained-call */
// These rules makes the xml strings harder to read
/* eslint-disable operator-linebreak, max-len */

describe('ChatRoomEncrypted', () => {
    
    describe('EncryptedChat: sendMessage', () => {
        let room: ChatRoom;
        let connectionSpy: jasmine.Spy;
        const key: Uint8Array = genSymmetricKey();
        let cryptoKey: CryptoKey;

        beforeEach(() => {
            const xmpp: IMockXMPP = {
                moderator: new Moderator({
                    options: {}
                } as any),
                options: {},
                addListener: () => {} // eslint-disable-line no-empty-function
            };

            room = new ChatRoom(
                // eslint-disable-next-line no-empty-function
                { send: () => {} } as any as XmppConnection /* connection */,
                'jid',
                'password',
                xmpp as any as XMPP,
                {} /* options */);
            room.setEncryptionKey(key);
            connectionSpy = spyOn(room.connection, 'send');
        });
        it('EncryptedChat: sends a string msg with elementName body correctly', () => {
            room.sendMessage('string message', 'body');
            const xml = connectionSpy.calls.argsFor(0).toString();

            expect(xml).not.toBe(
                '<message to="jid" type="groupchat" xmlns="jabber:client">' +
                '<body>string message</body>' +
                '</message>');
            expect(xml).toMatch(
                '<message to="jid" type="groupchat" xmlns="jabber:client">' +
                '<body>.*</body>' +
                '</message>'
            );

            const match = xml.match(/<body>([\s\S]*?)<\/body>/);
            const ciphertext = match ? match[1] : null;
            const decryptedText = decryptSymmetricallySync(ciphertext!, key);
            expect(decryptedText).toBe('string message');

        });
        it('EncryptedChat: sends a string msg with elementName json-message correctly', () => {
            room.sendMessage('string message', 'json-message');
            const xml = connectionSpy.calls.argsFor(0).toString();
            expect(xml).not.toBe(
                '<message to="jid" type="groupchat" xmlns="jabber:client">' +
                '<json-message xmlns="http://jitsi.org/jitmeet">string message</json-message>' +
                '</message>');
            expect(xml).toMatch(
                '<message to="jid" type="groupchat" xmlns="jabber:client">' +
                '<json-message xmlns="http://jitsi.org/jitmeet">.*</json-message>' +
                '</message>'
            );

            const match = xml.match(/<json-message xmlns="http:\/\/jitsi.org\/jitmeet">([\s\S]*?)<\/json-message>/);
            const ciphertext = match ? match[1] : null;

            const decryptedText = decryptSymmetricallySync(ciphertext!, key);
            expect(decryptedText).toBe('string message');
        });
    });

    describe('EncryptedChat: onMessage - group messages with display-name extension', () => {
        let room: ChatRoom;
        let emitterSpy: jasmine.Spy;
        const key: Uint8Array = genSymmetricKey();
        let cryptoKey: CryptoKey;

        beforeEach(() => {
            const xmpp = {
                moderator: new Moderator({
                    options: {}
                }),
                options: {},
                addListener: () => {} // eslint-disable-line no-empty-function
            } as unknown as XMPP;

            room = new ChatRoom(
                {} as XmppConnection/* connection */,
                'jid',
                'password',
                xmpp,
                {} /* options */);
        
            room.setEncryptionKey(key);
            emitterSpy = spyOn(room.eventEmitter, 'emit');
        });

        it('EncryptedChat: parses group message with display-name extension correctly', () => {
            const message = 'Hello from visitor to group';
            const ciphertext = encryptSymmetricallySync(message, key);
            const msgStr = '' +
                '<message to="jid" from="fromjid" type="groupchat" id="msg126" xmlns="jabber:client">' +
                    '<body>'+ ciphertext + '</body>' +
                    '<display-name xmlns="http://jitsi.org/protocol/display-name" source="visitor">Group Visitor</display-name>' +
                '</message>';
            const msg = new DOMParser().parseFromString(msgStr, 'text/xml').documentElement;

            room.onMessage(msg, 'fromjid');
            expect(emitterSpy.calls.count()).toEqual(1);
            expect(emitterSpy).toHaveBeenCalledWith(
                XMPPEvents.MESSAGE_RECEIVED,
                'fromjid',
                message,
                room.myroomjid,
                null, // stamp
                'Group Visitor', // displayName from visitor
                true, // isVisitorMessage
                'msg126', // messageId
                undefined, // source (null for visitor messages)
                null); // replyToId
        });

        it('parses group message with display-name extension source=token correctly', () => {
            const message = 'Hello from token user';
            const ciphertext = encryptSymmetricallySync(message, key);
            const msgStr = '' +
                '<message to="jid" from="fromjid" type="groupchat" id="msg127" xmlns="jabber:client">' +
                    '<body>'+ ciphertext + '</body>' +
                    '<display-name xmlns="http://jitsi.org/protocol/display-name" source="token">Token User</display-name>' +
                '</message>';
            const msg = new DOMParser().parseFromString(msgStr, 'text/xml').documentElement;

            room.onMessage(msg, 'fromjid');
            expect(emitterSpy.calls.count()).toEqual(1);
            expect(emitterSpy).toHaveBeenCalledWith(
                XMPPEvents.MESSAGE_RECEIVED,
                'fromjid',
                message,
                room.myroomjid,
                null, // stamp
                'Token User', // displayName
                false, // isVisitorMessage
                'msg127', // messageId
                'token', // source
                null); // replyToId
        });

        it('parses group message with display-name extension source=guest correctly', () => {
            const message = 'Hello from guest user';
            const ciphertext = encryptSymmetricallySync(message, key);
            const msgStr = '' +
                '<message to="jid" from="fromjid" type="groupchat" id="msg127b" xmlns="jabber:client">' +
                    '<body>'+ ciphertext + '</body>' +
                    '<display-name xmlns="http://jitsi.org/protocol/display-name" source="guest">Guest User</display-name>' +
                '</message>';
            const msg = new DOMParser().parseFromString(msgStr, 'text/xml').documentElement;

            room.onMessage(msg, 'fromjid');
            expect(emitterSpy.calls.count()).toEqual(1);
            expect(emitterSpy).toHaveBeenCalledWith(
                XMPPEvents.MESSAGE_RECEIVED,
                'fromjid',
                message,
                room.myroomjid,
                null, // stamp
                'Guest User', // displayName
                false, // isVisitorMessage
                'msg127b', // messageId
                'guest', // source
                null); // replyToId
        });

        it('parses group message with display-name extension from non-visitor correctly', () => {
            const message = 'Hello from regular user';
            const ciphertext = encryptSymmetricallySync(message, key);
            const msgStr = '' +
                '<message to="jid" from="fromjid" type="groupchat" id="msg127c" xmlns="jabber:client">' +
                    '<body>'+ ciphertext + '</body>' +
                    '<display-name xmlns="http://jitsi.org/protocol/display-name" source="jitsi-meet">Regular User</display-name>' +
                '</message>';
            const msg = new DOMParser().parseFromString(msgStr, 'text/xml').documentElement;

            room.onMessage(msg, 'fromjid');
            expect(emitterSpy.calls.count()).toEqual(1);
            expect(emitterSpy).toHaveBeenCalledWith(
                XMPPEvents.MESSAGE_RECEIVED,
                'fromjid',
                'Hello from regular user',
                room.myroomjid,
                null, // stamp
                'Regular User', // displayName
                false, // isVisitorMessage
                'msg127c', // messageId
                'jitsi-meet', // source
                null); // replyToId
        });

        it('parses group message without display-name extension correctly', () => {
            const message = 'Hello without display name extension';
            const ciphertext = encryptSymmetricallySync(message, key);
            const msgStr = '' +
                '<message to="jid" from="fromjid" type="groupchat" id="msg128" xmlns="jabber:client">' +
                   '<body>'+ ciphertext + '</body>' +
                '</message>';
            const msg = new DOMParser().parseFromString(msgStr, 'text/xml').documentElement;

            room.onMessage(msg, 'fromjid');
            expect(emitterSpy.calls.count()).toEqual(1);
            expect(emitterSpy).toHaveBeenCalledWith(
                XMPPEvents.MESSAGE_RECEIVED,
                'fromjid',
                message,
                room.myroomjid,
                null, // stamp
                undefined, // displayName
                false, // isVisitorMessage
                'msg128', // messageId
                undefined, // source (undefined when no display-name element)
                null); // replyToId
        });
    });
});
