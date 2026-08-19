const { patchSerializedIds } = require('../src/utils')

// Builds a stand-in for the WhatsApp Web page context. When `renamed` is true it mimics
// the WA Web 2.3000.x builds that expose the serialized id as `$1` instead of `_serialized`.
const createFakeWindow = ({ renamed }) => {
  const field = renamed ? '$1' : '_serialized'

  class Wid {
    constructor (jid) {
      const [user, server] = jid.split('@')
      this.user = user
      this.server = server
      this[field] = jid
    }
  }

  class MsgKey {
    constructor ({ fromMe, remote, id }) {
      this.fromMe = fromMe
      this.remote = remote
      this.id = id
      this[field] = `${fromMe}_${remote}_${id}`
    }
  }

  const modules = {
    WAWebWidFactory: { createWid: (jid) => new Wid(jid) },
    WAWebMsgKey: MsgKey
  }

  return {
    Wid,
    MsgKey,
    require: (name) => {
      if (!modules[name]) { throw new Error(`module ${name} is not available`) }
      return modules[name]
    },
    WWebJS: {
      getMessageModel: (message) => ({ ...message }),
      getChatModel: async (chat) => ({ ...chat }),
      getContactModel: (contact) => ({ ...contact })
    }
  }
}

const createFakeClient = (fakeWindow) => ({
  pupPage: {
    evaluate: async (pageFunction, ...args) => {
      global.window = fakeWindow
      try {
        return await pageFunction(...args)
      } finally {
        delete global.window
      }
    }
  }
})

describe('patchSerializedIds', () => {
  describe('on builds that renamed _serialized to $1', () => {
    let fakeWindow

    beforeEach(async () => {
      fakeWindow = createFakeWindow({ renamed: true })
      await patchSerializedIds(createFakeClient(fakeWindow))
    })

    it('reports what it patched', async () => {
      const result = await patchSerializedIds(createFakeClient(createFakeWindow({ renamed: true })))
      expect(result.applied).toBe(true)
      expect(result.patchedPrototypes).toEqual(['Wid', 'MsgKey'])
      expect(result.patchedModels).toEqual(['getMessageModel', 'getChatModel', 'getContactModel'])
    })

    it('restores _serialized on message keys, which is what sendMessage looks up', () => {
      const key = new fakeWindow.MsgKey({ fromMe: true, remote: '123@c.us', id: 'ABCD' })
      expect(key._serialized).toBe('true_123@c.us_ABCD')
    })

    it('restores _serialized on wids', () => {
      const wid = fakeWindow.require('WAWebWidFactory').createWid('123@c.us')
      expect(wid._serialized).toBe('123@c.us')
    })

    it('keeps _serialized writable', () => {
      const wid = fakeWindow.require('WAWebWidFactory').createWid('123@c.us')
      wid._serialized = '456@c.us'
      expect(wid._serialized).toBe('456@c.us')
    })

    it('restores _serialized on the plain ids returned by the model getters', async () => {
      const model = fakeWindow.WWebJS.getMessageModel({
        id: { fromMe: true, remote: '123@c.us', id: 'ABCD', $1: 'true_123@c.us_ABCD' },
        body: 'hello'
      })
      expect(model.id._serialized).toBe('true_123@c.us_ABCD')

      const chat = await fakeWindow.WWebJS.getChatModel({ id: { user: '123', server: 'c.us', $1: '123@c.us' } })
      expect(chat.id._serialized).toBe('123@c.us')
    })

    it('does not apply twice', async () => {
      const wrapped = fakeWindow.WWebJS.getMessageModel
      const result = await patchSerializedIds(createFakeClient(fakeWindow))
      expect(result.applied).toBe(false)
      expect(fakeWindow.WWebJS.getMessageModel).toBe(wrapped)
    })
  })

  describe('on builds that still expose _serialized', () => {
    it('leaves the page untouched', async () => {
      const fakeWindow = createFakeWindow({ renamed: false })
      const getMessageModel = fakeWindow.WWebJS.getMessageModel

      const result = await patchSerializedIds(createFakeClient(fakeWindow))

      expect(result.applied).toBe(false)
      expect(fakeWindow.WWebJS.getMessageModel).toBe(getMessageModel)
      expect(Object.getOwnPropertyDescriptor(fakeWindow.Wid.prototype, '_serialized')).toBeUndefined()
      expect(Object.getOwnPropertyDescriptor(fakeWindow.MsgKey.prototype, '_serialized')).toBeUndefined()
    })
  })
})
