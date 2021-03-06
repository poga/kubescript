const yaml = require('js-yaml')
const fs = require('fs')
const path = require('path')
const util = require('util')
const ora = require('ora')
let mkdirp = require('mkdirp')
mkdirp = util.promisify(mkdirp)

// setup require hook
const loader = require('./loader')
const packageData = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json')))
loader.register(packageData)

const Events = require('./events')
const { spawn, getEventgatewayIP } = require('./util')

function Builder () {
  this.events = new Events()
  this.subscriptions = {}

  this.functions = {}
}

Builder.prototype.on = function (event, handler) {
  this._subscribe({ event, handler })
}

Builder.prototype.get = function (path, handler) {
  this._subscribe({ event: 'http', method: 'GET', path, handler })
}

Builder.prototype.post = function (path, handler) {
  this._subscribe({ event: 'http', method: 'POST', path, handler })
}

Builder.prototype.put = function (path, handler) {
  this._subscribe({ event: 'http', method: 'PUT', path, handler })
}

Builder.prototype.delete = function (path, handler) {
  this._subscribe({ event: 'http', method: 'DELETE', path, handler })
}

Builder.prototype._subscribe = function ({ event, method, path, handler }) {
  this.events.register({ event, method, path, handler })
}

Builder.prototype.emit = function () {
  // no-op and compile-time

  throw new Error('emit is a no-op at compile-time')
}

Builder.prototype.run = async function (outPrefix, opts) {
  if (!outPrefix) outPrefix = './out'
  if (!opts) opts = {}

  let out = path.resolve(outPrefix)

  await mkdirp(out)

  // 1. generate yamls

  var spinner = ora('Figuring out configurations...').start()

  // basic infrastructure
  fs.copyFileSync(path.join(__dirname, 'yaml', 'conduit.yaml'), path.join(out, 'conduit.yaml'))
  fs.copyFileSync(path.join(__dirname, 'yaml', 'etcd.yaml'), path.join(out, 'etcd.yaml'))
  fs.copyFileSync(path.join(__dirname, 'yaml', 'event-gateway.yaml'), path.join(out, 'event-gateway.yaml'))

  var dockerfile
  if (opts.dockerfilePath) {
    dockerfile = fs.readFileSync(opts.dockerfilePath).toString()
  } else {
    dockerfile = fs.readFileSync(__dirname, 'yaml', 'Dockerfile').toString()
  }

  // update Dockerfile to use the specified entry point
  let mainFile = path.basename(process.argv[1])
  dockerfile = dockerfile.replace('CMD npm start', `CMD node ${mainFile}`)
  fs.writeFileSync(path.join(process.cwd(), 'Dockerfile'), dockerfile)

  // app pod
  let imagePrefix = packageData.KubeScript.prefix || ''
  const appImageTag = `${imagePrefix}${packageData.name}:${packageData.version}`

  // setup app deployment
  let appd = yaml.safeLoad(fs.readFileSync(path.join(__dirname, 'yaml', 'base.yaml')))
  appd.metadata.name = packageData.name
  appd.spec.selector = { matchLabels: { app: packageData.name } }
  appd.spec.template.metadata.labels.app = packageData.name
  appd.spec.template.metadata.annotations = { builtAt: `${new Date()}`, builtWith: 'KubeScript' }
  appd.spec.template.spec.containers[0].image = appImageTag
  appd.spec.template.spec.containers[0].name = packageData.name
  appd.spec.template.spec.containers[0].readinessProbe = {
    httpGet: {
      path: '/readinessProbe',
      port: 3000
    },
    initialDelaySeconds: 1,
    timeoutSeconds: 1,
    periodSeconds: 15
  }
  fs.writeFileSync(path.join(out, 'app.raw.yaml'), yaml.safeDump(appd))
  await spawn('sh', ['-c', `conduit inject ${path.join(out, 'app.raw.yaml')} > ${path.join(out, 'app.yaml')}`])
  fs.unlinkSync(path.join(out, 'app.raw.yaml'))

  // setup app service
  let apps = yaml.safeLoad(fs.readFileSync(path.join(__dirname, 'yaml', 'base.service.yaml')))
  apps.spec.selector.app = packageData.name
  fs.writeFileSync(path.join(out, 'app.service.raw.yaml'), yaml.safeDump(apps))
  await spawn('sh', ['-c', `conduit inject ${path.join(out, 'app.service.raw.yaml')} > ${path.join(out, 'app.service.yaml')}`])
  fs.unlinkSync(path.join(out, 'app.service.raw.yaml'))

  // dependent pods
  await loader.build(out)

  succeed(spinner)

  spinner = ora('Building app image...').start()
  // 2. build image
  await spawn('docker', ['build', '-t', appImageTag, '.'])

  // push to repo
  await spawn('docker', ['push', appImageTag])
  succeed(spinner)

  // 3. apply to k8s
  // setup conduit & event gateway
  spinner = ora('Setting up infrastructure ...').start()
  await spawn('kubectl', ['apply', '-f', path.join(out, 'conduit.yaml')])
  await spawn('kubectl', ['apply', '-f', path.join(out, 'etcd.yaml')])
  await spawn('kubectl', ['apply', '-f', path.join(out, 'event-gateway.yaml')])
  await spawn('kubectl', ['rollout', 'status', 'deploy/controller', '--namespace=conduit'])
  await spawn('kubectl', ['rollout', 'status', 'deploy/event-gateway'])
  succeed(spinner)

  spinner = ora('Building dependencies...').start()
  // // * setup required containers & service
  await loader.apply(out)
  succeed(spinner)

  // // * setup app pods & services
  spinner = ora('Deploying your app...').start()
  // // deploy app
  await spawn('kubectl', ['apply', '-f', path.join(out, 'app.yaml')])
  await spawn('kubectl', ['apply', '-f', path.join(out, 'app.service.yaml')])
  await spawn('kubectl', ['rollout', 'status', `deploy/${packageData.name}`])
  succeed(spinner)

  // setup event-gateway
  spinner = ora('Wiring up events...').start()
  // get event-gateway external IP
  let eventgatewayIP = await getEventgatewayIP()
  await this.events.apply(eventgatewayIP)
  succeed(spinner)

  console.log(`\n🎉 Your app is ready at http://${eventgatewayIP}:4000/`)
}

module.exports = Builder

function succeed (spinner) {
  spinner.succeed(spinner.text + 'done')
}
