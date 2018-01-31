#!/usr/bin/node

const http = require('http')

class HTTPRelay {
  constructor(ip, port) {
    this._ip = ip
    this._port = port
    this._connectionToHandler = new WeakMap()

    this.server = http.createServer((request, response) => {
      response.writeHead(404)
      response.end()
    })

    this.server.listen(this._port, this._ip, () => {
      console.log(`Server is listening on port ${port}`)
    })
  }
}

exports.HTTPRelay = HTTPRelay
