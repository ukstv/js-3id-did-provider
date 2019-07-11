import nacl from 'tweetnacl'
import naclutil from 'tweetnacl-util'
nacl.util = naclutil
import { HDNode } from 'ethers/utils'
import { SimpleSigner } from 'did-jwt'
import crypto from 'crypto'

const sha256 = msg => crypto.createHash('sha256').update(msg).digest('hex')

const BASE_PATH = "m/51073068'/0'"
const ROOT_STORE_PATH = "0'/0'/0'/0'/0'/0'/0'/0'"


class Keyring {
  constructor (seed) {
    this._seed = seed
    this._baseNode = HDNode.fromSeed(this._seed).derivePath(BASE_PATH)
    const rootNode = this._baseNode.derivePath(ROOT_STORE_PATH)
    this._rootKeys = {
      signingKey: rootNode.derivePath("0"),
      managementKey: rootNode.derivePath("1"),
      asymEncryptionKey: nacl.box.keyPair.fromSecretKey(new Uint8Array(
        Buffer.from(rootNode.derivePath("2").privateKey.slice(2), 'hex')
      )),
      symEncryptionKey: new Uint8Array(Buffer.from(rootNode.derivePath("3").privateKey.slice(2), 'hex'))
    }
    this._spaceKeys = {}
  }

  _deriveSpaceKeys (space) {
    const spaceHash = sha256(`${space}.3box`)
    // convert hash to path
    const spacePath = spaceHash.match(/.{1,12}/g) // chunk hex string
      .map(n => parseInt(n, 16).toString(2)) // convert to binary
      .map(n => (n.length === 47 ? '0' : '') + n) // make sure that binary strings have the right length
      .join('').match(/.{1,31}/g) // chunk binary string for path encoding
      .map(n => parseInt(n, 2)).join("'/") + "'" // convert to uints and create path
    const spaceNode = this._baseNode.derivePath(spacePath)
    this._spaceKeys[space] = {
      signingKey: spaceNode.derivePath("0"),
      asymEncryptionKey: nacl.box.keyPair.fromSecretKey(new Uint8Array(
        Buffer.from(spaceNode.derivePath("2").privateKey.slice(2), 'hex')
      )),
      symEncryptionKey: new Uint8Array(Buffer.from(spaceNode.derivePath("3").privateKey.slice(2), 'hex'))
    }
  }

  _getKeys (space) {
    if (!space) {
      return this._rootKeys
    } else if (!this._spaceKeys[space]) {
      this._deriveSpaceKeys(space)
    }
    return this._spaceKeys[space]
  }

  asymEncrypt (msg, toPublic, { space, nonce } = {}) {
    nonce = nonce || randomNonce()
    toPublic = nacl.util.decodeBase64(toPublic)
    if (typeof msg === 'string') {
      msg = nacl.util.decodeUTF8(msg)
    }
    const ciphertext = nacl.box(msg, nonce, toPublic, this._getKeys(space).asymEncryptionKey.secretKey)
    return {
      nonce: nacl.util.encodeBase64(nonce),
      ciphertext: nacl.util.encodeBase64(ciphertext)
    }
  }

  asymDecrypt (ciphertext, fromPublic, nonce, { space, toBuffer } = {}) {
    fromPublic = nacl.util.decodeBase64(fromPublic)
    ciphertext = nacl.util.decodeBase64(ciphertext)
    nonce = nacl.util.decodeBase64(nonce)
    const cleartext = nacl.box.open(ciphertext, nonce, fromPublic, this._getKeys(space).asymEncryptionKey.secretKey)
    if (toBuffer) {
      return cleartext ? Buffer.from(cleartext) : null
    }
    return cleartext ? nacl.util.encodeUTF8(cleartext) : null
  }

  symEncrypt (msg, { space, nonce } = {}) {
    return symEncryptBase(msg, this._getKeys(space).symEncryptionKey, nonce)
  }

  symDecrypt (ciphertext, nonce, { space, toBuffer } = {}) {
    return symDecryptBase(ciphertext, this._getKeys(space).symEncryptionKey, nonce, toBuffer)
  }

  getJWTSigner (space) {
    return SimpleSigner(this._getKeys(space).signingKey.privateKey.slice(2))
  }

  getDBSalt (space) {
    return sha256(this._getKey(space).signingKey.derivePath('0').privateKey.slice(2))
  }

  getPublicKeys ({ space, uncompressed } = {}) {
    const keys = this._getKeys(space)
    let signingKey = keys.signingKey.publicKey.slice(2)
    let managementKey = keys.managementKey ? keys.managementKey.publicKey.slice(2) : null
    if (uncompressed) {
      signingKey = ec.keyFromPublic(Buffer.from(signingKey, 'hex')).getPublic(false, 'hex')
      managementKey = managementKey ? ec.keyFromPublic(Buffer.from(managementKey, 'hex')).getPublic(false, 'hex') : null
    }
    return {
      signingKey,
      managementKey,
      encryptionKey: nacl.util.encodeBase64(keys.asymEncryptionKey.publicKey)
    }
  }

  serialize () {
    return this._seed
  }
}

const randomNonce = () => {
  return nacl.randomBytes(24)
}

const symEncryptBase = (msg, symKey, nonce) => {
  nonce = nonce || randomNonce()
  if (typeof msg === 'string') {
    msg = nacl.util.decodeUTF8(msg)
  }
  const ciphertext = nacl.secretbox(msg, nonce, symKey)
  return {
    nonce: nacl.util.encodeBase64(nonce),
    ciphertext: nacl.util.encodeBase64(ciphertext)
  }
}

const symDecryptBase = (ciphertext, symKey, nonce, toBuffer) => {
  ciphertext = nacl.util.decodeBase64(ciphertext)
  nonce = nacl.util.decodeBase64(nonce)
  const cleartext = nacl.secretbox.open(ciphertext, nonce, symKey)
  if (toBuffer) {
    return cleartext ? Buffer.from(cleartext) : null
  }
  return cleartext ? nacl.util.encodeUTF8(cleartext) : null
}

module.exports = Keyring