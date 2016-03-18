/**
 * Client-side accounts
 */

"use strict";

var BigNumber = require("bignumber.js");
var ethTx = require("ethereumjs-tx");
var keys = require("keythereum");
var uuid = require("node-uuid");
var clone = require("clone");
var locks = require("locks");
var abi = require("augur-abi");
var errors = require("augur-contracts").errors;
var constants = require("../constants");
var utils = require("../utilities");

BigNumber.config({ MODULO_MODE: BigNumber.EUCLID });

keys.constants.pbkdf2.c = constants.ROUNDS;
keys.constants.scrypt.n = constants.ROUNDS;

module.exports = function () {

    var augur = this;

    return {

        // The account object is set when logged in
        account: {},

        // free (testnet) ether for new accounts on registration
        fund: function (account, branch, onRegistered, onSendEther, onSent, onSuccess, onFailed) {
            var self = this;
            if (onRegistered.constructor === Object && onRegistered.onRegistered) {
                if (onRegistered.onSendEther) onSendEther = onRegistered.onSendEther;
                if (onRegistered.onSent) onSent = onRegistered.onSent;
                if (onRegistered.onSuccess) onSuccess = onRegistered.onSuccess;
                if (onRegistered.onFailed) onFailed = onRegistered.onFailed;
                onRegistered = onRegistered.onRegistered;
            }
            onRegistered = onRegistered || utils.noop;
            onSendEther = onSendEther || utils.noop;
            onSent = onSent || utils.noop;
            onSuccess = onSuccess || utils.noop;
            onFailed = onFailed || utils.noop;
            augur.rpc.coinbase(function (funder) {
                if (!funder || funder.error) return onSendEther();
                augur.rpc.sendEther({
                    to: account.address,
                    value: constants.FREEBIE,
                    from: funder,
                    onSent: function (r) {
                        onRegistered(account);
                    },
                    onSuccess: function (r) {
                        onSendEther(account);
                        augur.fundNewAccount({
                            branch: branch || augur.branches.dev,
                            onSent: onSent,
                            onSuccess: onSuccess,
                            onFailed: onFailed
                        });
                    },
                    onFailed: onSendEther
                });
            });
        },

        // options: {doNotFund, persist}
        register: function (handle, password, options, onRegistered, onSendEther, onSent, onSuccess, onFailed) {
            var i, self = this;
            if (!onRegistered && options) {
                if (utils.is_function(options)) {
                    onRegistered = options;
                    options = {};
                }
            }
            if (onRegistered && onRegistered.constructor === Object && onRegistered.onRegistered) {
                if (onRegistered.onSendEther) onSendEther = onRegistered.onSendEther;
                if (onRegistered.onSent) onSent = onRegistered.onSent;
                if (onRegistered.onSuccess) onSuccess = onRegistered.onSuccess;
                if (onRegistered.onFailed) onFailed = onRegistered.onFailed;
                onRegistered = onRegistered.onRegistered;
            }
            onRegistered = onRegistered || utils.noop;
            onSendEther = onSendEther || utils.noop;
            onSent = onSent || utils.noop;
            onSuccess = onSuccess || utils.noop;
            onFailed = onFailed || utils.noop;
            options = options || {};
            if (!password || password.length < 6) return onRegistered(errors.PASSWORD_TOO_SHORT);
            augur.db.get(handle, function (record) {
                if (!record || !record.error) return onRegistered(errors.HANDLE_TAKEN);

                // generate ECDSA private key and initialization vector
                keys.create(null, function (plain) {
                    if (plain.error) return onRegistered(plain);

                    // derive secret key from password
                    keys.deriveKey(password, plain.salt, null, function (derivedKey) {
                        if (derivedKey.error) return onRegistered(derivedKey);

                        if (!Buffer.isBuffer(derivedKey))
                            derivedKey = new Buffer(derivedKey, "hex");

                        var encryptedPrivateKey = new Buffer(keys.encrypt(
                            plain.privateKey,
                            derivedKey.slice(0, 16),
                            plain.iv
                        ), "base64").toString("hex");

                        var mac = keys.getMAC(derivedKey, encryptedPrivateKey);
                        var id = new Buffer(uuid.parse(uuid.v4()));
                        var address = abi.format_address(keys.privateKeyToAddress(plain.privateKey));

                        // encrypt private key using derived key and IV, then
                        // store encrypted key & IV, indexed by handle
                        var accountData = {
                            ciphertext: abi.prefix_hex(encryptedPrivateKey), // 256-bit
                            iv: abi.prefix_hex(plain.iv.toString("hex")), // 128-bit
                            mac: abi.prefix_hex(mac), // 256-bit
                            cipher: keys.constants.cipher,
                            kdf: constants.KDF,
                            kdfparams: {
                                c: keys.constants[constants.KDF].c,
                                dklen: keys.constants[constants.KDF].dklen,
                                prf: keys.constants[constants.KDF].prf,
                                salt: abi.prefix_hex(plain.salt.toString("hex")) // 256-bit
                            },
                            id: abi.prefix_hex(id.toString("hex")), // 128-bit
                            persist: options.persist // bool
                        };
                        if (options.persist) {
                            accountData.privateKey = abi.hex(plain.privateKey, true);
                            accountData.address = address;
                        }
                        augur.db.put(handle, accountData, function (result) {
                            if (!result) return onRegistered(errors.DB_WRITE_FAILED);
                            if (result.error) return onRegistered(result);

                            // set web.account object
                            delete accountData.privateKey;
                            delete accountData.address;
                            delete accountData.persist;
                            accountData.ciphertext = accountData.ciphertext.toString("hex");
                            accountData.address = abi.strip_0x(address);
                            accountData.iv = accountData.iv.toString("hex");
                            accountData.kdfparams.salt = accountData.kdfparams.salt.toString("hex");
                            accountData.mac = accountData.mac.toString("hex");
                            accountData.id = uuid.unparse(new Buffer(abi.strip_0x(accountData.id), "hex"));
                            self.account = {
                                handle: handle,
                                privateKey: plain.privateKey,
                                address: address,
                                keystore: accountData
                            };
                            if (options.persist) {
                                augur.db.putPersistent(self.account);
                            }

                            augur.ramble.invoke = self.invoke;
                            augur.ramble.context = self;
                            augur.ramble.from = self.account.address;
                            if (options.doNotFund) return onRegistered(self.account);
                            self.fund(self.account, augur.branches.dev, onRegistered, onSendEther, onSent, onSuccess, onFailed);

                        }); // augur.db.put
                    }); // deriveKey
                }); // create
            }); // augur.db.get
        },

        login: function (handle, password, options, cb) {
            var self = this;
            if (!cb && utils.is_function(options)) {
                cb = options;
                options = {};
            }
            options = options || {};

            // blank password
            if (!password || password === "") return cb(errors.BAD_CREDENTIALS);

            // retrieve account info from database
            augur.db.get(handle, function (stored) {
                if (!stored || stored.error) return cb(errors.BAD_CREDENTIALS);

                // derive secret key from password
                keys.deriveKey(password, stored.kdfparams.salt, null, function (derived) {
                    if (!derived || derived.error) return cb(errors.BAD_CREDENTIALS);

                    // verify that message authentication codes match
                    var storedKey = stored.ciphertext;
                    if (keys.getMAC(derived, storedKey) !== stored.mac.toString("hex")) {
                        return cb(errors.BAD_CREDENTIALS);
                    }

                    if (!Buffer.isBuffer(derived))
                        derived = new Buffer(derived, "hex");

                    // decrypt stored private key using secret key
                    try {
                        var dk = new Buffer(keys.decrypt(
                            storedKey,
                            derived.slice(0, 16),
                            stored.iv
                        ), "hex");

                        // while logged in, web.account object is set
                        var address = abi.format_address(keys.privateKeyToAddress(dk));
                        delete stored.handle;
                        stored.ciphertext = stored.ciphertext.toString("hex");
                        stored.address = abi.strip_0x(address);
                        stored.iv = stored.iv.toString("hex");
                        stored.kdfparams.salt = stored.kdfparams.salt.toString("hex");
                        stored.mac = stored.mac.toString("hex");
                        stored.id = uuid.unparse(stored.id);
                        self.account = {
                            handle: handle,
                            privateKey: dk,
                            address: address,
                            keystore: stored
                        };
                        if (options.persist) {
                            augur.db.putPersistent(self.account);
                        }
                        augur.ramble.invoke = self.invoke;
                        augur.ramble.context = self;
                        augur.ramble.from = self.account.address;
                        cb(self.account);

                    // decryption failure: bad password
                    } catch (e) {
                        if (utils.is_function(cb)) {
                            cb(errors.BAD_CREDENTIALS);
                        }
                    }
                }); // deriveKey
            }); // augur.db.get
        },

        persist: function () {
            var account = augur.db.getPersistent();
            if (account && account.privateKey) {
                this.account = account;
                augur.ramble.invoke = this.invoke;
                augur.ramble.context = this;
                augur.ramble.from = account.address;
            }
            return account;
        },

        exportKey: function () {
            if (!this.account || !this.account.address || !this.account.privateKey) {
                return errors.NOT_LOGGED_IN;
            }
            if (this.account.keystore && this.account.keystore.ciphertext) {
                var kdfparams = clone(this.account.keystore.kdfparams);
                kdfparams.salt = abi.strip_0x(kdfparams.salt);
                return {
                    address: abi.strip_0x(this.account.address),
                    Crypto: {
                        cipher: abi.strip_0x(this.account.keystore.cipher),
                        ciphertext: abi.strip_0x(this.account.keystore.ciphertext),
                        cipherparams: {iv: abi.strip_0x(this.account.keystore.iv)},
                        mac: abi.strip_0x(this.account.keystore.mac),
                        kdf: this.account.keystore.kdf,
                        kdfparams: kdfparams
                    },
                    id: this.account.keystore.id,
                    version: 3
                };
            }
        },

        importKey: function (password, json, cb) {
            if (!utils.is_function(cb)) {
                return keys.recover(password, JSON.parse(json));
            }
            keys.recover(password, JSON.parse(json), function (keyObj) {
                cb(keyObj);
            });
        },

        logout: function () {
            this.account = {};
            augur.ramble.invoke = null;
            augur.ramble.context = augur.rpc;
            augur.ramble.from = null;
            augur.db.removePersistent();
            augur.rpc.clear();
        },

        invoke: function (itx, cb) {
            var self = this;
            var tx, packaged;

            // if this is just a call, use ethrpc's regular invoke method
            if (!itx.send) return augur.rpc.fire(itx, cb);

            cb = cb || utils.pass;
            if (!this.account.address) return cb(errors.NOT_LOGGED_IN);
            if (!this.account.privateKey || !itx || itx.constructor !== Object) {
                return cb(errors.TRANSACTION_FAILED);
            }

            // parse and serialize transaction parameters
            tx = clone(itx);
            if (tx.params !== undefined) {
                if (tx.params.constructor === Array) {
                    for (var i = 0, len = tx.params.length; i < len; ++i) {
                        if (tx.params[i] !== undefined &&
                            tx.params[i].constructor === BigNumber) {
                            tx.params[i] = abi.hex(tx.params[i]);
                        }
                    }
                } else if (tx.params.constructor === BigNumber) {
                    tx.params = abi.hex(tx.params);
                }
            }
            if (tx.to) tx.to = abi.prefix_hex(tx.to);

            // package up the transaction and submit it to the network
            packaged = {
                to: tx.to,
                from: this.account.address,
                gasLimit: (tx.gas) ? tx.gas : constants.DEFAULT_GAS,
                nonce: 0,
                value: tx.value || "0x0",
                data: abi.encode(tx)
            };
            if (tx.timeout) packaged.timeout = tx.timeout;
            if (tx.gasPrice && abi.number(tx.gasPrice) > 0) {
                packaged.gasPrice = tx.gasPrice;
                return this.getTxNonce(packaged, cb);
            }
            augur.rpc.gasPrice(function (gasPrice) {
                if (!gasPrice || gasPrice.error) {
                    return cb(errors.TRANSACTION_FAILED);
                }
                packaged.gasPrice = gasPrice;
                self.getTxNonce(packaged, cb);
            });
        },

        submitTx: function (packaged, cb) {
            var self = this;
            var mutex = locks.createMutex();
            mutex.lock(function () {
                for (var rawTxHash in augur.rpc.rawTxs) {
                    if (!augur.rpc.rawTxs.hasOwnProperty(rawTxHash)) continue;
                    if (augur.rpc.rawTxs[rawTxHash].nonce === packaged.nonce) {
                        ++packaged.nonce;
                        break;
                    }
                }
                mutex.unlock();
                var etx = new ethTx(packaged);

                // sign, validate, and send the transaction
                etx.sign(self.account.privateKey);

                // transaction validation
                if (!etx.validate()) return cb(errors.TRANSACTION_INVALID);

                // send the raw signed transaction to geth
                augur.rpc.sendRawTx(etx.serialize().toString("hex"), function (res) {
                    var err;
                    if (res) {

                        // geth error -32603: nonce too low / known tx
                        if (res.error === -32603) {

                            // rlp encoding error also has -32603 error code
                            if (res.message.indexOf("rlp") > -1) {
                                console.error("RLP encoding error:", res);
                                err = clone(errors.RLP_ENCODING_ERROR);
                                err.bubble = res;
                                err.packaged = packaged;
                                return cb(err);
                            }

                            ++packaged.nonce;
                            return self.submitTx(packaged, cb);

                        // other errors
                        } else if (res.error) {
                            console.error("submitTx error:", res);
                            err = clone(errors.RAW_TRANSACTION_ERROR);
                            err.bubble = res;
                            err.packaged = packaged;
                            return cb(err);
                        }

                        // res is the txhash if nothing failed immediately
                        // (even if the tx is nulled, still index the hash)
                        augur.rpc.rawTxs[res] = {tx: packaged};

                        // nonce ok, execute callback
                        return cb(res);
                    }
                    cb(errors.TRANSACTION_FAILED);
                });
            });
        },

        // get nonce: number of transactions
        getTxNonce: function (packaged, cb) {
            var self = this;
            augur.rpc.txCount(self.account.address, function (txCount) {
                if (txCount && !txCount.error && !(txCount instanceof Error)) {
                    packaged.nonce = parseInt(txCount);
                }
                self.submitTx(packaged, cb);
            });
        }

    };
};
