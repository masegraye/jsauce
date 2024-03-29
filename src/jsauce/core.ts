/// <reference path="./lib.d.ts" />

import thicket  = require("thicket");
import _        = require("underscore");
import Promise  = require("bluebird");
import mori     = require("mori");

var Options    = thicket.c("options"),
    UUID       = thicket.c("uuid"),
    Lang       = thicket.c("lang"),
    Courier    = thicket.c("messaging/courier");



export interface IReplyMessage extends thicket.IMessage {}
export interface IHandshakeMessage extends thicket.IMTypedMessage {}
export interface IHandshakeReplyMessage extends IReplyMessage {}
export interface IWillShowMessage extends thicket.IMTypedMessage {}
export interface IDidShowMessage extends thicket.IMTypedMessage {}
export interface IWillHideMessage extends thicket.IMTypedMessage {}
export interface IDidHideMessage extends thicket.IMTypedMessage {}
export interface IMessageMessage extends thicket.IMTypedMessage {
    data: any;
}

export var Defaults = {
    DefaultProcessHandshakeTimeout: 1000
};

export var Errors = {
    InvalidProcessSpecType: Lang.makeErrorClass("InvalidProcessSpecType", "An invalid process spec type was provided"),
    HandshakeTimeoutError: Lang.makeErrorClass("HandshakeTimeoutError", "New process failed to handshake in time")
};

export var Messages = {
    Handshake: Lang.makeMTypeBuilder("handshake"),
    Message: Lang.makeMTypeBuilder("message", ["data"], { defaults: {data: null} })
};

export interface IProcessSpec {
    /**
     * One of: "local" or "remote"
     */
    pType: string;
}

export interface ILocalProcessDelegate extends IProcessMessageTarget {}

export interface IProcessContext {}

export interface ILocalProcessSpec extends IProcessSpec {
    handshakeTimeout?: number;
    delegateBuilder: (ctx: IProcessContext) => ILocalProcessDelegate;
}

export interface IPid {
    id(): string;
}

export interface IProcess {
    mailboxId() : string;
}

export interface IProcessMessageTarget {
    onReqHandshake?(msg: IHandshakeMessage): Promise<IHandshakeReplyMessage>;
    onMsgWillShow?(msg: IWillShowMessage): void;
    onMsgDidShow?(msg: IDidShowMessage): void;

    onMsgWillHide?(msg: IWillHideMessage): void;
    onMsgDidHide?(msg: IDidHideMessage): void;

    onMsgMessage?(msg: IMessageMessage): void;
}

export interface IProcessManagerOpts {}

export class ProcessManager {
    private _procs: mori.HashMap<string,IPid>;
    private _exchange: thicket.Exchange;
    private _mailbox: thicket.Mailbox;
    private _courier: thicket.Courier;
    private _handshakeTimeout: number;

    constructor(o?: IProcessManagerOpts) {
        var opts = Options.fromObject(o);
        this._exchange         = opts.getOrError("exchange");
        this._procs            = mori.hashMap<string,IPid>();
        this._mailbox          = this._exchange.mailbox(opts.getOrElse("mailboxId", UUID.v4()));

        // TODO: Maybe make configurable
        this._handshakeTimeout = Defaults.DefaultProcessHandshakeTimeout;

        this._courier    = new Courier({
            mailbox: this._mailbox,
            delegate: this
        });
    }

    mailboxId() {
        return this._mailbox.id();
    }

    launch(spec: IProcessSpec) : Promise<IPid> {
        return Promise
            .bind(this)
            .then(function(){
                if (spec.pType === "local") {
                    return this._launchLocal(<ILocalProcessSpec> spec);
                } else {
                    throw new Errors.InvalidProcessSpecType();
                }
            })
    }

    sendMessage(processMailboxId: string, data: any) {
        this._courier.send(processMailboxId, Messages.Message({
            data: data
        }));
    }

    doesOwn(pid: IPid) : boolean {
        return mori.hasKey(this._procs, pid.id());
    }

    dispose() : void {

    }

    _launchLocal(spec: ILocalProcessSpec) : Promise<IPid> {
        return Promise
            .bind(this)
            .then(function(): IPid {
                var mbox = this._exchange.mailbox(UUID.v4()),
                    processContext = this._createDelegateContext(),
                    delegate = spec.delegateBuilder(processContext),
                    pid  = new LocalPid({
                        mailboxId: mbox.ownerIdentity(),
                        processManager: this
                    }),
                    proc = new LocalProcess({
                        id: pid.id(),
                        processManagerMailboxId: this.mailboxId(),
                        mailbox: mbox,
                        delegate: delegate
                    });

                return this._courier
                    .sendAndReceive(mbox.ownerIdentity(), Messages.Handshake())
                    .bind(this)
                    .timeout(spec.handshakeTimeout || this._handshakeTimeout)
                    .then(function() {
                        this._procs = mori.assoc(this._procs, pid.id(), proc);
                        return pid;
                    })
                    .catch(Promise.TimeoutError, function(err) {
                        throw new Errors.HandshakeTimeoutError();
                    })
            });
    }

    _createDelegateContext() {
        return {};
    }
}

export interface ILocalProcessOpts {
    id: string;
    processManagerMailboxId: string;
    mailbox: thicket.Mailbox;
    delegate: ILocalProcessDelegate;
}

export class LocalProcess implements IProcess {
    private _id:       string;
    private _pmMboxId: string;
    private _mailbox:  thicket.Mailbox;
    private _delegate: ILocalProcessDelegate;
    private _courier: thicket.Courier;


    constructor(o?: ILocalProcessOpts) {
        var opts       = Options.fromObject(o);
        this._id       = opts.getOrError("id");
        this._pmMboxId = opts.getOrError("processManagerMailboxId");
        this._mailbox  = opts.getOrError("mailbox");
        this._delegate = opts.getOrError("delegate");

        this._courier  = new Courier({
            mailbox: this._mailbox,
            delegate: this._delegate
        });
    }

    mailboxId(): string {
        return this._mailbox.id();
    }

}

export interface ILocalPidOpts {
    mailboxId: string;
    processManager: ProcessManager;
}

export class LocalPid implements IPid {
    private _mailboxId: string;
    private _processManager: ProcessManager;

    constructor(o?:ILocalPidOpts) {
        var opts = Options.fromObject(o);

        this._mailboxId      = opts.getOrError("mailboxId");
        this._processManager = opts.getOrError("processManager");
    }

    /**
     * For now, we're using the mailboxId as the processId, but that could change.
     * Treat this as an opaque value.
     *
     * @returns {string}
     */
    id(): string {
        return this._mailboxId;
    }

    send(data: any) {
        this._processManager.sendMessage(this._mailboxId, data);
    }
}
