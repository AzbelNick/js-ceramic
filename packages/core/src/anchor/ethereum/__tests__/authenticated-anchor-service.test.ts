import { jest } from '@jest/globals'
import { LoggerProvider } from '@ceramicnetwork/common'
import { createIPFS } from '@ceramicnetwork/ipfs-daemon'
import { createCeramic } from '../../../__tests__/create-ceramic.js'
import { createDidAnchorServiceAuth } from '../../../__tests__/create-did-anchor-service-auth.js'
import { AuthenticatedEthereumAnchorService } from '../ethereum-anchor-service.js'
import { generateFakeCarFile } from './generateFakeCarFile.js'
import { AnchorRequestStatusName } from '@ceramicnetwork/codecs'
import { lastValueFrom } from 'rxjs'

describe('AuthenticatedEthereumAnchorServiceTest', () => {
  let ipfs: any
  let ceramic: any

  beforeAll(async () => {
    ipfs = await createIPFS()
    ceramic = await createCeramic(ipfs, { streamCacheLimit: 1, anchorOnRequest: true })
  })

  afterAll(async () => {
    ceramic && (await ceramic.close())
    ipfs && (await ipfs.stop())
  })

  test('Should authenticate header during call to supported_chains endpoint in init()', async () => {
    const loggerProvider = new LoggerProvider()
    const diagnosticsLogger = loggerProvider.getDiagnosticsLogger()
    const url = 'http://example.com'
    const chainIdUrl = url + '/api/v0/service-info/supported_chains'

    const { auth } = createDidAnchorServiceAuth(url, ceramic, diagnosticsLogger)
    const signRequestSpy = jest.spyOn(auth, 'signRequest')
    const sendRequestSpy = jest.spyOn(auth, '_sendRequest')
    const anchorService = new AuthenticatedEthereumAnchorService(auth, url, diagnosticsLogger, 100)

    sendRequestSpy.mockImplementationOnce(async (request) => {
      expect(request.url).toEqual(chainIdUrl)
      return { supportedChains: ['eip:1337'] }
    })

    await anchorService.init()

    expect(signRequestSpy).toHaveBeenCalledTimes(1)
  })

  test('Should authenticate header when creating anchor requests', async () => {
    const loggerProvider = new LoggerProvider()
    const diagnosticsLogger = loggerProvider.getDiagnosticsLogger()
    const url = 'http://example.com'
    const requestsUrl = url + '/api/v0/requests'

    const { auth } = createDidAnchorServiceAuth(url, ceramic, diagnosticsLogger)
    const signRequestSpy = jest.spyOn(auth, 'signRequest')
    const sendRequestSpy = jest.spyOn(auth, '_sendRequest')
    const anchorService = new AuthenticatedEthereumAnchorService(auth, url, diagnosticsLogger, 100)

    sendRequestSpy.mockImplementationOnce(async (request) => {
      expect(request.url).toEqual(requestsUrl)
      // this response won't pass codec deserialization b/c it doesn't conform to the proper format
      return { status: AnchorRequestStatusName.PENDING }
    })

    const observable = await anchorService.requestAnchor(generateFakeCarFile(), false)
    const anchorStatus = await lastValueFrom(observable)
    expect(anchorStatus.status).toEqual(AnchorRequestStatusName.FAILED) // because the response didn't match the expected format

    // This is the important check: the request was signed
    // TODO: would be better to actually check the request header is constructed properly
    expect(signRequestSpy).toHaveBeenCalledTimes(1)
  })
})
