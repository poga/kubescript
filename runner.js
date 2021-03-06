const Koa = require('koa')
const Router = require('koa-router')
const logger = require('koa-logger')
const cors = require('@koa/cors')
const request = require('request-promise')
const bodyParser = require('koa-bodyparser')
const fs = require('fs')
const path = require('path')

const { functionId, eventFunctionId } = require('./util')

const DEFAULT_EVENT_GATEWAY_HOST = 'event-gateway'

// setup require hook
const loader = require('./loader')
const packageData = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json')))
loader.register(packageData)

function Runner (eventGatewayHost) {
  if (!eventGatewayHost) eventGatewayHost = DEFAULT_EVENT_GATEWAY_HOST

  this.EG = eventGatewayHost
  this.router = new Router()
}

Runner.prototype.on = function (event, handler) {
  this.router.post(`/${eventFunctionId(event)}`, handler)
}

Runner.prototype.get = function (path, handler) {
  this.router.post(`/${functionId('get', path)}`, handler)
}

Runner.prototype.post = function (path, handler) {
  this.router.post(`/${functionId('post', path)}`, handler)
}

Runner.prototype.put = function (path, handler) {
  this.router.post(`/${functionId('put', path)}`, handler)
}

Runner.prototype.delete = function (path, handler) {
  this.router.post(`/${functionId('delete', path)}`, handler)
}

Runner.prototype.emit = async function (event, payload) {
  await request({
    method: 'POST',
    uri: `http://${this.EG}:4000/`,
    headers: {
      Event: event
    },
    body: payload,
    json: true
  })
}

Runner.prototype.run = function () {
  let app = new Koa()
  this.app = app

  // setup liveness check
  this.router.get('/readinessProbe', function (ctx) {
    ctx.body = 'ok'
  })

  app
    .use(async(ctx, next) => {
      try {
        await next()
      } catch (e) {
        ctx.status = e.status || 500
        ctx.body = e.message
        ctx.app.emit('error', e, ctx)
      }
    })
    .use(cors())
    .use(logger())
    .use(bodyParser())
    .use(async (ctx, next) => {
      await next()
      let body = ctx.body
      let headers = ctx.response.headers
      let statusCode = ctx.status
      ctx.body = JSON.stringify({ body, headers, statusCode })
      ctx.status = 200
    })
    .use(this.router.routes())
    .use(this.router.allowedMethods())

  return app.listen(3000)
}

module.exports = Runner
