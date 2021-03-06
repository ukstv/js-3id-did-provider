import tmp from 'tmp-promise'
import Ceramic from '@ceramicnetwork/core'
import { DID } from 'dids'
import { Ed25519Provider } from 'key-did-provider-ed25519'
import KeyResolver from 'key-did-resolver'
import Ipfs from 'ipfs'
import all from 'it-all'
import CID from 'cids'
import { AccountID } from 'caip'
import { schemas, definitions } from '@ceramicstudio/idx-constants'
import { publishIDXConfig } from '@ceramicstudio/idx-tools'
import { randomBytes } from '@stablelib/random'

import { ThreeIDX } from '../src/three-idx'
import { DidProvider } from '../src/did-provider'
import Keyring from '../src/keyring'
import { fakeEthProvider } from '../src/utils'

import dagJose from 'dag-jose'
import basicsImport from 'multiformats/cjs/src/basics-import.js'
import legacy from 'multiformats/cjs/src/legacy.js'
import * as u8a from 'uint8arrays'

const seed = u8a.fromString('8e641c0dc77f6916cc7f743dad774cdf9f6f7bcb880b11395149dd878377cd398650bbfd4607962b49953c87da4d7f3ff247ed734b06f96bdd69479377bc612b', 'base16')
const KEYCHAIN_DEF = definitions.threeIdKeychain

const genIpfsConf = (folder) => {
  basicsImport.multicodec.add(dagJose)
  const format = legacy(basicsImport, dagJose.name)
  return {
    ipld: { formats: [format] },
    repo: `${folder}/ipfs/`,
    config: {
      Addresses: { Swarm: [] },
      Bootstrap: []
    },
    silent: true,
  }
}

const randomSecret = () => '0x' + Buffer.from(randomBytes(32)).toString('hex')

const fakeJWE = () => ({
  jwe: {
    protected: 'prot',
    tag: 'tag',
    ciphertext: randomSecret(),
    iv: 'iv',
  }
})
const genAuthEntryCreate = async () => {
  const provider = new Ed25519Provider(randomBytes(32))
  const did = new DID({ provider, resolver: KeyResolver.getResolver() })
  await did.authenticate()
  return {
    did,
    mapEntry: {
      [did.id]: {
        data: fakeJWE(),
        id: fakeJWE(),
      }
    }
  }
}

const setup3id = async (threeIdx, keyring) => {
  const genState = keyring.get3idState(true)
  const forcedDID = genState.metadata.controllers[0]
  let didProvider = new DidProvider({ permissions: mockedPermissions, threeIdx, keyring, forcedDID })
  await threeIdx.setDIDProvider(didProvider)
  await threeIdx.create3idDoc(genState)
  didProvider = new DidProvider({ permissions: mockedPermissions, threeIdx, keyring })
  await threeIdx.setDIDProvider(didProvider)
}

const mockedPermissions = {
  request: async () => [],
  has: () => true,
}

describe('ThreeIDX', () => {
  jest.setTimeout(25000)
  let tmpFolder
  let ipfs, ceramic
  let keyring, threeIdx

  beforeAll(async () => {
    tmpFolder = await tmp.dir({ unsafeCleanup: true })
    ipfs = await Ipfs.create(genIpfsConf(tmpFolder.path))
    ceramic = await Ceramic.create(ipfs, { stateStorePath: tmpFolder.path + '/ceramic/' })
    await publishIDXConfig(ceramic)
  })

  afterAll(async () => {
    await ceramic.close()
    await ipfs.stop()
    await tmpFolder.cleanup()
  })

  beforeEach(async () => {
    keyring = new Keyring(randomBytes(32))
    threeIdx = new ThreeIDX(ceramic)
  })

  it('creates 3id doc', async () => {
    keyring = new Keyring(seed)
    await setup3id(threeIdx, keyring)
    const { log, ...state } = threeIdx.docs.threeId.state
    expect({  ...state, log: log.map(({ cid }) => new CID(cid.bytes)) }).toMatchSnapshot()
  })

  it('handles v0 3ID correctly', async () => {
    const v03ID = 'did:3:abc234'
    await setup3id(threeIdx, keyring)
    const v13ID = threeIdx.id
    threeIdx.setV03ID(v03ID)
    expect(threeIdx.id).not.toEqual(v13ID)
    expect(threeIdx.id).toEqual(v03ID)
  })

  it('gets correct 3id version', async () => {
    await setup3id(threeIdx, keyring)
    // with no anchor
    expect(threeIdx.get3idVersion()).toEqual('0')
    // with anchor, createIDX to update 3id doc
    await threeIdx.createIDX()
    // update the 3id doc
    await threeIdx.docs.threeId.change({ content: { asdf: 123 }})
    await new Promise(resolve => threeIdx.docs.threeId.on('change', resolve))
    const latestCommit = threeIdx.docs.threeId.commitId.commit
    expect(threeIdx.get3idVersion()).toEqual(latestCommit.toString())
  })

  it('creates authMapEntry', async () => {
    await setup3id(threeIdx, keyring)
    const newAuthEntry = await genAuthEntryCreate()
    const update = await threeIdx.createAuthLinkUpdate(newAuthEntry)

    expect(update.did).toEqual(newAuthEntry.did.id)
    expect(threeIdx.docs[update.did].controllers).toEqual([newAuthEntry.did.id])
    expect(threeIdx.docs[update.did].content).toEqual({})

    await threeIdx.applyAuthLinkUpdate(update)
    expect(threeIdx.docs[update.did].content).toEqual({ did: threeIdx.id })
  })

  it('createIDX with new auth entry', async () => {
    await setup3id(threeIdx, keyring)
    const newAuthEntry = await genAuthEntryCreate()
    await threeIdx.createIDX(newAuthEntry)

    expect(threeIdx.docs[KEYCHAIN_DEF].content).toEqual({
      authMap: newAuthEntry.mapEntry,
      pastSeeds: []
    })
    expect(threeIdx.docs.idx.content).toEqual({ [KEYCHAIN_DEF]: threeIdx.docs[KEYCHAIN_DEF].id.toUrl('base36') })
    expect(threeIdx.docs.idx.metadata.schema).toBe(schemas.IdentityIndex)
    expect(threeIdx.docs[KEYCHAIN_DEF].metadata.schema).toBe(schemas.ThreeIdKeychain)
    // should be pinned
    expect(await all(await ceramic.pin.ls())).toEqual(expect.arrayContaining([
      threeIdx.docs.threeId.id.toString(),
      threeIdx.docs.idx.id.toString(),
      threeIdx.docs[KEYCHAIN_DEF].id.toString(),
      threeIdx.docs[newAuthEntry.did.id].id.toString(),
    ].map(docid => docid.replace('ceramic://', '/ceramic/'))))
  })

  it('createIDX with no auth entry', async () => {
    await setup3id(threeIdx, keyring)
    await threeIdx.createIDX()

    expect(threeIdx.docs.idx.content).toEqual({ [KEYCHAIN_DEF]: threeIdx.docs[KEYCHAIN_DEF].id.toUrl('base36') })
    expect(threeIdx.docs.idx.metadata.schema).toBe(schemas.IdentityIndex)
    expect(threeIdx.docs[KEYCHAIN_DEF].metadata.schema).toBeUndefined()
    // should be pinned
    expect(await all(await ceramic.pin.ls())).toEqual(expect.arrayContaining([
      threeIdx.docs.threeId.id.toString(),
      threeIdx.docs.idx.id.toString(),
    ].map(docid => docid.replace('ceramic://', '/ceramic/'))))
  })

  it('loadIDX fails if authLink does not exist', async () => {
    await setup3id(threeIdx, keyring)
    const newAuthEntry = await genAuthEntryCreate(threeIdx.id)

    expect(await threeIdx.loadIDX(newAuthEntry.did.id)).toEqual(null)
  })

  it('loadIDX works if IDX created', async () => {
    await setup3id(threeIdx, keyring)
    const newAuthEntry = await genAuthEntryCreate(threeIdx.id)
    await threeIdx.createIDX(newAuthEntry)

    expect(await threeIdx.loadIDX(newAuthEntry.did.id)).toEqual({
      seed: newAuthEntry.mapEntry[newAuthEntry.did.id].data,
      pastSeeds: []
    })
  })

  it('resetIDX throws an error if there is no IDX doc', async () => {
    await expect(threeIdx.resetIDX()).rejects.toThrow('No IDX doc')
  })

  it('resetIDX resets the IDX doc', async () => {
    await setup3id(threeIdx, keyring)
    await threeIdx.createIDX()
    await threeIdx.resetIDX()

    expect(threeIdx.docs.idx.content).toEqual({ [KEYCHAIN_DEF]: threeIdx.docs[KEYCHAIN_DEF].id.toUrl('base36') })
    expect(threeIdx.docs.idx.metadata.schema).toBe(schemas.IdentityIndex)
    expect(threeIdx.docs[KEYCHAIN_DEF].metadata.schema).toBeUndefined()
  })

  it('addAuthEntries', async () => {
    await setup3id(threeIdx, keyring)
    const [nae1, nae2, nae3] = await Promise.all([
      genAuthEntryCreate(threeIdx.id),
      genAuthEntryCreate(threeIdx.id),
      genAuthEntryCreate(threeIdx.id)
    ])
    await threeIdx.createIDX(nae1)
    expect(threeIdx.getAuthMap()).toEqual(nae1.mapEntry)
    await threeIdx.addAuthEntries([nae2, nae3])

    expect(threeIdx.getAuthMap()).toEqual({ ...nae1.mapEntry, ...nae2.mapEntry, ...nae3.mapEntry })
    expect(await all(await ceramic.pin.ls())).toEqual(expect.arrayContaining([
      threeIdx.docs[nae1.did.id].id.toString(),
      threeIdx.docs[nae2.did.id].id.toString(),
      threeIdx.docs[nae3.did.id].id.toString(),
    ]))
  })

  it('rotateKeys', async () => {
    await setup3id(threeIdx, keyring)
    const [nae1, nae2, nae3] = await Promise.all([
      genAuthEntryCreate(threeIdx.id),
      genAuthEntryCreate(threeIdx.id),
      genAuthEntryCreate(threeIdx.id)
    ])
    await threeIdx.createIDX(nae1)
    await threeIdx.addAuthEntries([nae2, nae3])
    const doc = threeIdx.docs[KEYCHAIN_DEF]

    // Rotate keys correctly
    await keyring.generateNewKeys(threeIdx.get3idVersion())
    const new3idState = keyring.get3idState()
    const updatedAuthMap = {
      [nae1.did.id]: { data: fakeJWE(), id: fakeJWE() },
      [nae2.did.id]: { data: fakeJWE(), id: fakeJWE() }
    }
    await threeIdx.rotateKeys(new3idState, keyring.pastSeeds, updatedAuthMap)
    expect(threeIdx.getAuthMap()).toEqual(updatedAuthMap)
    const state = threeIdx.docs.threeId.state
    expect(state.content).toEqual(expect.objectContaining(new3idState.content))
    expect(state.metadata.controllers).toEqual(new3idState.metadata.controllers)

    // load 3id with rotated keys
    expect(await threeIdx.loadIDX(nae1.did.id)).toEqual({
      seed: updatedAuthMap[nae1.did.id].data,
      pastSeeds: keyring.pastSeeds
    })
  })
})
