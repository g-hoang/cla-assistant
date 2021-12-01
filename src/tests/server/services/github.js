/*global describe, it, beforeEach*/

// unit test
const rewire = require('rewire')
const assert = require('assert')
const sinon = require('sinon')
// const stringify = require('json-stable-stringify')

// config
global.config = require('../../../server/src/config')

// service
const github = rewire('../../../server/src/services/github')

//model
const Cache = require('../../../server/src/documents/cache').Cache

const callStub = sinon.stub()
const authenticateStub = sinon.stub()
const createInstallationAccessTokenStub = sinon.stub()
const getUserInstallationStub = sinon.stub()

let testRes = {}
let testErr = {}

const stub = () => {
    testErr.cacheFindOne = 'error'
    testErr.cacheCreate = 'error'

    testRes.cacheFindOne = {
        cache_key: 'cacheKey',
        cache_value: {
            headers: {
                etag: "W/'438f72f7fa7e852df83950aaa1a8934c582027daafa782945102c6d6fbf1ab4c'"
            },
            data: {}
        },
        save: sinon.stub().resolves(),
    }
    testRes.cacheCreate = 'success'

    sinon.stub(Cache, 'findOne').callsFake(async () => {
        if (testErr.cacheFindOne === null) {
            throw testErr.cacheFindOne
        }
        return testRes.cacheFindOne
    })
    sinon.stub(Cache, 'create').callsFake(async () => {
        if (testErr.cacheCreate === null) {
            throw testErr.cacheCreate
        }
        return testRes.cacheCreate
    })

    sinon.stub(Cache, 'exists').callsFake(async () => {
        return false
    })
}

describe('github:call', () => {
    let expectedAuth

    // base OctokitMock handles the configuration options
    function OctokitMock(args) {
        assert.strictEqual(args.protocol, 'https')
        assert.strictEqual(args.version, '3.0.0')
        assert.strictEqual(args.host, 'api.github.com')
        assert.strictEqual(args.pathPrefix, null)
    }

    // custom Octokit Class is called with authentication and actually executes commands
    function OctokitWithPluginsAndDefaultsMock(args) {
        assert.deepStrictEqual(args.auth, expectedAuth)

        this.obj = {
            fun: callStub,
            listSomething: {
                endpoint: {
                    merge: function (args) {
                        return args
                    }
                }
            }
        }
        this.authenticate = authenticateStub
        this.paginate = callStub
        this.apps = {
            getUserInstallation: getUserInstallationStub,
            createInstallationAccessToken: createInstallationAccessTokenStub
        }
    }

    // custom getInstallationAccessToken function
    function fakeInstallationToken(owner) {
        if (owner) {
            return 'ghs_12345abc'
        }
    }

    function fakeErrorInstallationToken(owner) {
        throw Error(owner)
     }

    github.__set__('Octokit', OctokitMock)
    github.__set__('OctokitWithPluginsAndDefaults', OctokitWithPluginsAndDefaultsMock)

    beforeEach(() => {
        stub()
        github.resetList = {}
        callStub.reset()
        expectedAuth = undefined
        authenticateStub.reset()
    })

    afterEach(() => {
        Cache.findOne.restore()
        Cache.create.restore()
        Cache.exists.restore()
    })

    it('should return an error if obj is not set', async () => {
        try {
            await github.call({})
            assert(false, 'Should throw an error')
        } catch (error) {
            assert.equal(error.message, 'undefined required/object not found or specified')
        }
    })

    it('should return an error if fun is not set', async () => {
        try {
            await github.call({ obj: 'obj' })
            assert(false, 'Should throw an error')
        } catch (error) {
            assert.equal(error.message, 'obj.undefined required/function not found or specified')
        }
    })

    it('should authenticate when token is set', async () => {
        expectedAuth = 'token token'
        callStub.resolves({ data: {}, meta: {} })

        await github.call({
            obj: 'obj',
            fun: 'fun',
            token: 'token'
        })
    })

    it('should authenticate when basic authentication is required', async () => {
        expectedAuth = {
            username: 'user',
            password: 'pass'
        }
        callStub.resolves({ data: {}, meta: {} })
        await github.call({
            obj: 'obj',
            fun: 'fun',
            basicAuth: {
                user: 'user',
                pass: 'pass'
            }
        })
    })

    it('should not authenticate when neither token nor basicAuth are provided', async () => {
        expectedAuth = undefined
        callStub.resolves({ data: {}, meta: {} })
        await github.call({
            obj: 'obj',
            fun: 'fun'
        })
    })

    it('should call appropriate function on the github api', async () => {
        const testHeaders = {
            link: null,
            'x-oauth-scopes': []
        }
        callStub.resolves({ data: {}, headers: testHeaders })
        const res = await github.call({
            obj: 'obj',
            fun: 'fun'
        })
        assert.deepStrictEqual(res, { data: {}, headers: testHeaders })
    })

    it('should return github error', async () => {
        callStub.rejects('github error')
        try {
            await github.call({
                obj: 'obj',
                fun: 'fun'
            })
            assert(false, 'Should throw an error')
        } catch (error) {
            assert.equal(error, 'Error: fun.obj: github error')
        }
    })

    it('should check cache for github call results if isUseETag is provided', async () => {
        testErr.cacheFindOne = null
        const mockInput = {
            obj: 'obj',
            fun: 'fun',
            arg: { isUseETag: true }
        }

        await github.call(mockInput)
        assert(Cache.findOne.called)
    })

    it('should use cache for github call results if isUseETag is provided and github returns 304', async () => {
        callStub.rejects({ status: 304 })
        const mockInput = {
            obj: 'obj',
            fun: 'fun',
            arg: { isUseETag: true }
        }
        const res = await github.call(mockInput)
        assert.equal(res, testRes.cacheFindOne.cache_value)
    })

    it('should create cache if isUseETag is provided and the response header contains etag', async () => {
        callStub.resolves(testRes.cacheFindOne.cache_value)
        testErr.cacheFindOne = null
        const mockInput = {
            obj: 'obj',
            fun: 'fun',
            arg: { isUseETag: true }
        }
        await github.call(mockInput)
        assert(Cache.create.called)
    })

    it('callWithGitHubApp should use installation token if created by getInstallationAccessToken', async () => {
        github.__set__('getInstallationAccessToken', fakeInstallationToken)
        const githubCall = sinon.stub(github, 'call').resolves({ data: {}, headers: {} })

        await github.callWithGitHubApp({
            token: 'ghu_123',
            owner: 'app-installer-name'
        })
        sinon.assert.calledWith(githubCall,{
            token: 'ghs_12345abc'
        })
        githubCall.restore()
    })

    it('callWithGitHubApp should use user token if getInstallationAccessToken throws error', async () => {
        github.__set__('getInstallationAccessToken', fakeErrorInstallationToken)
        const githubCall = sinon.stub(github, 'call').resolves({ data: {}, headers: {} })

        await github.callWithGitHubApp({
            owner: 'app-installer-name',
            token: 'ghu_123'
        })
        sinon.assert.calledWith(githubCall, {
            token: 'ghu_123'
        })
        githubCall.restore()
    })

    it('should use user token if owner is not existed inside request', async () => {
        let spy = sinon.spy(github, 'call')
        expectedAuth = 'token ghu_123'

        await github.callWithGitHubApp({
            obj: 'obj',
            fun: 'fun',
            token: 'ghu_123'
        })

        assert.strictEqual(spy.args[0][0].token, 'ghu_123')

        github.call.restore()
    })

    it('should not contain owner key inside the input of github.call', async () => {
        // custom getInstallationAccessToken function
        function fakeInstallationToken(owner) {
            if (owner) {
                return 'ghs_12345abc'
            }
        }
        github.__set__('getInstallationAccessToken', fakeInstallationToken)
        let spy = sinon.spy(github, 'call')
        expectedAuth = 'token ghs_12345abc'

        await github.callWithGitHubApp({
            obj: 'obj',
            fun: 'fun',
            token: 'ghu_123',
            owner: 'app-installer-name'
        })

        assert(!('owner' in spy.args[0][0]))
        assert.strictEqual(spy.args[0][0].owner, undefined)
        github.call.restore()
    })

})
