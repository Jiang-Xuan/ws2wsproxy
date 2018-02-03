const { HTTPRelay } = require('./httprelay')
const { WSRelay } = require('./wsrelay')
const secretConfig = require('../secret.js').config

const WEBSOCKETPROXYADDR = secretConfig.proxy_addr
const WEBSOCKETPROXYPORT = secretConfig.proxy_port

function main () {
  const httprelay = new HTTPRelay(WEBSOCKETPROXYADDR, WEBSOCKETPROXYPORT)

  const wsrelay = new WSRelay(httprelay.server, secretConfig)

  global.wsrelay = wsrelay

  process.on('SIGINT', () => {
    console.log('收到 SIGINT 信号')
    process.exit(1)
  })
}

if (require.main === module) {
  main()
}
