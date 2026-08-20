const { Message } = require('whatsapp-web.js/src/structures')
const { patchMediaDownload } = require('../src/utils')

// The failure this patch exists for: WhatsApp Web 2.3000.x keeps the Msg collection under a key
// the serialized id no longer matches, so `Msg.get()` misses and whatsapp-web.js falls through to
// `Msg.getMessagesById()`, whose IndexedDB lookup throws a minified DataError. `indexedKeys` names
// the keys this fake page will actually resolve - everything else behaves like the broken build.
const createFakeWindow = ({ indexedKeys = [], models = [], mediaStage = 'RESOLVED' } = {}) => {
  const calls = { get: [], getMessagesById: 0, downloadAndMaybeDecrypt: 0 }

  const message = {
    id: { fromMe: false, remote: '120363402133099473@g.us', id: 'ACAF63', participant: '167474247016533@lid' },
    mediaData: { mediaStage },
    directPath: '/v/t62.enc',
    encFilehash: 'enc',
    filehash: 'plain',
    mediaKey: 'key',
    mediaKeyTimestamp: 1787239177,
    type: 'image',
    mimetype: 'image/jpeg',
    filename: undefined,
    size: 96945,
    downloadMedia: async () => { message.mediaData.mediaStage = 'RESOLVED' }
  }

  const modules = {
    WAWebCollections: {
      Msg: {
        get: (key) => {
          calls.get.push(key)
          if (indexedKeys.includes(key)) { return message }
          // what the real build does for a key it cannot use
          const error = new Error("Failed to execute 'get' on 'IDBObjectStore': No key or key range specified.")
          error.name = 'DataError'
          throw error
        },
        getMessagesById: async () => {
          calls.getMessagesById++
          throw new Error('the IndexedDB fallback must never be reached')
        }
      }
    },
    WAWebDownloadManager: {
      downloadManager: {
        downloadAndMaybeDecrypt: async () => {
          calls.downloadAndMaybeDecrypt++
          return new ArrayBuffer(8)
        }
      }
    }
  }

  return {
    calls,
    message,
    require: (name) => {
      if (!modules[name]) { throw new Error(`module ${name} is not available`) }
      return modules[name]
    },
    WWebJS: {
      arrayBufferToBase64Async: async () => 'BASE64DATA',
      // the collection `_getMessageById` already reads to hand the message to the caller
      getChat: async () => ({
        msgs: { getModelsArray: () => models.map((m) => (m === 'match' ? message : { id: { id: 'other' } })) }
      })
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

const download = (fakeWindow, overrides = {}) => {
  const client = createFakeClient(fakeWindow)
  patchMediaDownload()
  return Message.prototype.downloadMedia.call({
    hasMedia: true,
    client,
    id: { ...fakeWindow.message.id, _serialized: 'false_120363402133099473@g.us_ACAF63_167474247016533@lid' },
    ...overrides
  })
}

describe('patchMediaDownload', () => {
  it('downloads through the serialized id when the collection still indexes it', async () => {
    const fakeWindow = createFakeWindow({ indexedKeys: ['false_120363402133099473@g.us_ACAF63_167474247016533@lid'] })

    const media = await download(fakeWindow)

    expect(media).toMatchObject({ mimetype: 'image/jpeg', data: 'BASE64DATA', filesize: 96945 })
    expect(fakeWindow.calls.getMessagesById).toBe(0)
  })

  it('falls back to the three part key the older builds used', async () => {
    const fakeWindow = createFakeWindow({ indexedKeys: ['false_120363402133099473@g.us_ACAF63'] })

    await expect(download(fakeWindow)).resolves.toMatchObject({ data: 'BASE64DATA' })
    expect(fakeWindow.calls.get).toEqual([
      'false_120363402133099473@g.us_ACAF63_167474247016533@lid',
      'false_120363402133099473@g.us_ACAF63'
    ])
  })

  it('scans the chat collection when no key resolves, instead of hitting IndexedDB', async () => {
    const fakeWindow = createFakeWindow({ indexedKeys: [], models: ['other', 'match'] })

    await expect(download(fakeWindow)).resolves.toMatchObject({ data: 'BASE64DATA' })
    // reaching this is what produced the opaque `t: t` in production
    expect(fakeWindow.calls.getMessagesById).toBe(0)
  })

  it('reports why the media is missing rather than a minified class name', async () => {
    const fakeWindow = createFakeWindow({ indexedKeys: [], models: ['other'] })

    await expect(download(fakeWindow)).rejects.toThrow('message is not in the page collection')
  })

  it('resolves the media first when the page has not fetched it yet', async () => {
    const fakeWindow = createFakeWindow({
      indexedKeys: ['false_120363402133099473@g.us_ACAF63_167474247016533@lid'],
      mediaStage: 'INIT'
    })

    await expect(download(fakeWindow)).resolves.toMatchObject({ data: 'BASE64DATA' })
    expect(fakeWindow.calls.downloadAndMaybeDecrypt).toBe(1)
  })

  it('surfaces the real error when decrypting fails', async () => {
    const fakeWindow = createFakeWindow({ indexedKeys: ['false_120363402133099473@g.us_ACAF63_167474247016533@lid'] })
    fakeWindow.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt = async () => {
      throw new Error('media not on the server')
    }

    await expect(download(fakeWindow)).rejects.toThrow('decrypting the media failed')
  })

  it('leaves a message without media alone', async () => {
    const fakeWindow = createFakeWindow()

    await expect(download(fakeWindow, { hasMedia: false })).resolves.toBeUndefined()
    expect(fakeWindow.calls.get).toEqual([])
  })
})
