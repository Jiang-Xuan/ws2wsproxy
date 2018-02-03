#!/usr/bin/node
const { server: WebSocketServer, client: WebSocketClient } = require('websocket')
const fetch = require('node-fetch')

/* 连接共处于 * 个阶段 */

const STAFE_ACCEPT_CLIENT = 0x01
const STAGE_CREATE_CONTAINER = 0x02
const STAGE_CONNECTING_DOCKER = 0x04
const STAGE_CONNECTED_DOCER = 0x08
const STAGE_STREAM = 0x16

/* 数据流方向 */
const CONTAINER2CLIENT = 0x01
const CLIENT2CONTAINER = 0x02

const DATADIRECTIONNAME = {
  [CONTAINER2CLIENT]: 'CONTAINER2CLIENT',
  [CLIENT2CONTAINER]: 'CLIENT2CONTAINER'
}

/* Response code */
const RES_CODE_SERVICE_UNAVAILABLE = 503 // 连接超过上限, 无法创建容器, 也许等待一会儿资源会被释放
const RES_CODE_CONNECT_ACCEPTED = 201 // websocket 代理服务器已经接受连接并且允许获得容器

const RES_CODE_ATTEMPING_CREATE_CONTAINER = 219 // 尝试创建容器, 只是创建, 并不启动
const RES_CODE_CREATED_CONTAINER_SUCCESSFUL = 200 // 创建容器成功, 但是容器还没有启动起来

const RES_CODE_START_CONTAINER_SUCCESSFUL = 220 // 启动容器成功, 但是还没有建立和容器的 websocket 连接
const RES_CODE_REQUEST_WEBSOCKET_TO_CONTAINER = 221 // websocket 代理请求建立和容器的 websocket 连接
const RES_CODE_SUCCESSFUL_WEBSOCKET_TO_CONTAINER = 222 // websocket 代理请求建立和容器的 websocket 连接
/* Response code END */

let CONNECTION_LIMIT = 1
let CONNECTION_COUNT = 0

class WSRelayHandler {
  /**
   * 创建 WSrelayHandler
   * @param  { WeakMap } connectionToHandler WSRelay 中的 WeakMap
   * @param  { Object } connection          客户端的 websocket 连接
   * @return { undefined }
   */
  constructor(connectionToHandler, connection, config) {
    console.log('创建 WSrelayHandler')
    if (CONNECTION_COUNT >= CONNECTION_LIMIT) {
      console.log('连接超过上限, 断开连接')
      connection.sendUTF(JSON.stringify({ code: 503, message: 'limited' }))
      connection.close(1008)
      return
    }
    this._connectionToHandler = connectionToHandler

    this._connectionToHandler.set(connection, this)
    this._connection = connection
    /* config */
    this._config = config
    this._server = this._config.server
    this._serverPort = this._config.server_port
    /* config END */
    this._containerConnection = null
    this._stage = STAFE_ACCEPT_CLIENT
    this._containerID = null
    this._connectionStart = Date.now()

    connection.sendUTF(JSON.stringify({ code: 201 , message: 'connect accepted' }))

    connection.on('message', this.connMessage.bind(this))
    connection.on('close', this.connClose.bind(this))

    console.log('尝试创建一个容器')
    connection.sendUTF(JSON.stringify({ code: 219, desc: 'Attemping create a container'}))
    this.tryGetContainer()
      .then(result => {
        connection.sendUTF(JSON.stringify({ code: 200, desc: 'Create container successful' }))
        this._stage = STAGE_CREATE_CONTAINER
        return this.connectionContainer(result)
      })
      .then(connectionContainerResult => {

      })
      .catch(e => {
        /* 暂定: 获取容器失败或者是启动容器失败都会走到这里 */
        debugger
        this._connection.close(1000, e.message)
      })
  }

  /**
   * client 发送数据
   * @param  { Object } message websocket message 通讯对象
   * @return { undefined }
   */
  connMessage(message) {
    if (!(this._stage & STAGE_STREAM)) {
      this._connection.sendUTF(JSON.stringify({ code: 202, message: 'progressing' }))
      return
    }

    if (this._stage & STAGE_STREAM) {
      this._handleStageStream(message, CLIENT2CONTAINER)
      return
    }
  }

  connClose(reasonCode, description) {
    const { _connection, _containerConnection, _containerID } = this
    if (!_containerConnection) {
      return
    }
    _containerConnection.close(1000, 'Browser closed connection')
    console.log('浏览器端关闭连接, 可以关闭 websocket 连接, 并销毁容器了.')

    this.killContainer()
      .then(result => {
        CONNECTION_COUNT -= 1
        console.log(`kill container ${_containerID} successful`)
      })
      .catch(e => {
        // 容器销毁失败, 致命错误, 应该发邮件通知一下
        /* TODO: send e-mail */
        debugger
      })
  }

  async killContainer() {
    const { _containerID } = this
    let killContainerResult

    try {
      killContainerResult = await fetch(`http://47.100.102.192:8010/containers/${_containerID}?force=1`, {
        method: 'DELETE'
      })

      if (killContainerResult.status !== 204) {
        throw new Error('killContainer error')
      }
    } catch (e) {
      Promise.reject(e)
    }

    return Promise.resolve(true)
  }

  /**
   * 连接已经建立成功, 开始 stream 通讯
   * @param  { Object } message         websocket message 通讯对象
   * @param  { Number } streamDirection 数据的通讯流向
   * @return { undefined }
   */
  _handleStageStream(message, streamDirection) {
    let data
    /* 浏览器传递过来的是 utf8 类型的数据 */
    if (message.type === 'utf8') {
      data = message.utf8Data
      /* docker container 传递过来的数据是 binary 类型的数据 */
    } else if (message.type === 'binary') {
      data = message.binaryData.toString()
    }
    console.log(`stream 阶段 -${DATADIRECTIONNAME[streamDirection]}-, 传输数据 ${data}`)
    const { _connection, _containerConnection } = this

    if (!_connection.connected || !_containerConnection.connected) {
      _connection.connected && _connection.close(1000, 'Other side already closed connection')
      _containerConnection.connected && _containerConnection.close(1000, 'Other side already closed connection')
      return
    }

    if (streamDirection & CLIENT2CONTAINER) {
      _containerConnection.sendUTF(data)
    } else if (streamDirection & CONTAINER2CLIENT) {
      _connection.sendUTF(data)
    }
  }

  /**
   * 请求启动 container
   * @param  { Object } result 请求创建容器的结果对象
   * @return { undefined }
   */
  async connectionContainer(result) {
    const { _connection } = this
    const { Id } = result

    this._containerID = Id

    this.startContainer()
      .then(result => {
        _connection.sendUTF(JSON.stringify({ code: 220, message: 'Start container successful' }))
        this.websocket2Container()
      })
      .catch(e => {
        /* 启动容器失败, 应该将该容器删除 */
        /* TODO: delete 容器 */
        debugger
      })

  }

  /**
   * 发起启动容器的请求
   * @return { undefined }
   */
  async startContainer() {
    const { _containerID } = this
    let startContainerResult

    try {
      startContainerResult = await fetch(`http://${this._server}:${this._serverPort}/containers/${_containerID}/start`, {
        method: 'POST'
      })

      if (startContainerResult.status !== 204) {
        throw new Error('startContainer error')
      }
    } catch (e) {
      return Promise.reject(e)
    }

    return Promise.resolve(true)
  }

  /**
   * 创建 websocket 客户端连接容器暴露的 websocket 接口
   * @return { undefined }
   */
  websocket2Container() {
    const { _containerID, _connection } = this
    const containerConnectionWebsocket = new WebSocketClient()

    containerConnectionWebsocket.on('connect', this.websocket2ContainerConnect.bind(this))

    _connection.sendUTF(JSON.stringify({ code: 221, message: 'Try to connect' }))
    containerConnectionWebsocket.connect(`ws://${this._server}:${this._serverPort}/containers/${_containerID}/attach/ws?stream=1&stdin=1&stdout=1&stderr=1`)
  }

  /**
   * websocket 客户端连接容器的时候出错
   * @param  {[type]} err [description]
   * @return {[type]}     [description]
   */
  websocket2ContainerFailed(err) {
    const { _connection } = this

    _connection.close(1000, err)
  }

  /**
   * websocket 客户端收到容器发来的数据
   * @param  { Object } message websocket 通讯 message 对象
   * @return { undefined }
   */
  websocket2ContainerMessage(message) {
    const { _connection, _containerConnection, _stage } = this

    if (this._stage & STAGE_STREAM) {
      this._handleStageStream(message, CONTAINER2CLIENT)
      return
    }
  }

  /**
   * websocket 客户端收到容器断开连接事件
   * @return {[type]} [description]
   */
  websocket2ContainerClose() {
    const { _connection } = this

    if (_connection.connected) {
      _connection.close(1000, '')
    } else {
      console.log('Docker has closed connection')
    }
  }

  /**
   * websocket 客户端连接 container websocket 入口点成功, 进入 STAGE_STREAM 阶段
   * @param  {[type]} connection [description]
   * @return {[type]}            [description]
   */
  websocket2ContainerConnect(connection) {
    connection.on('message', this.websocket2ContainerMessage.bind(this))
    connection.on('close', this.websocket2ContainerClose.bind(this))

    const { _connection } = this
    this._containerConnection = connection

    _connection.sendUTF(JSON.stringify({ code: 222, message: 'Connect container successful, you can type to interctive with terminal:)' }))

    this._stage = STAGE_STREAM
  }

  /**
   * 尝试从 docker 获取一个容器
   * @return { Object } 请求结果
   */
  async tryGetContainer() {
    let fetchContainerResult
      , json
    try {
      fetchContainerResult = await fetch(`http://${this._server}:${this._serverPort}/containers/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          Image: 'python',
          // Cmd: '/bin/bash',
          OpenStdin: true,
          Tty: true
        })
      })
      json = await fetchContainerResult.json()
      if (fetchContainerResult.status !== 201) {
        throw new Error(JSON.stringify({
          code: fetchContainerResult.status,
          message: json.message
        }))
      }
    } catch (e) {
      return Promise.reject(e)
    }

    /* 创建的容器上限 */
    CONNECTION_COUNT += 1
    return json
  }
}

class WSRelay {
  constructor(httpServer, config) {
    this._httpServer = httpServer
    this._config = config
    this._connectionToHandler = new WeakMap()

    this._wsServer = new WebSocketServer({
      httpServer: this._httpServer,
      autoAcceptConnections: false
    })

    this._wsServer.on('request', this.connRequest.bind(this))
  }

  clearConnection () {
    return this._connectionToHandler = new WeakMap()
  }

  allowOrigin(origin) {
    const { NODE_ENV } = process.env
    if (NODE_ENV === 'production') {
      if (origin !== 'https://jiang-xuan.github.io') {
        return false
      }
    }

    return true
  }

  connRequest(request) {
    if (!this.allowOrigin(request.origin)) {
      request.reject()
      return
    }

    const connection = request.accept('', request.origin)

    new WSRelayHandler(this._connectionToHandler, connection, this._config)
  }
}

exports.WSRelay = WSRelay
