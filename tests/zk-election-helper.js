#!/usr/bin/env node

/*
 * Run a http server node exporting the state of the election (leader/follower)
 *
 *   Run ZK manually: bin/zk-server tests/conf/zk /tmp/zk
 *   node tests/zk_election_helper.js
 */

var util = require('util');
var http = require('http');

var async = require('async');
var optimist = require('optimist');

var ZkClient = require('../lib/client').ZkClient;
var zkUtil = require('../lib/util');

var ZK_URL = '127.0.0.1:22181';

var DEFAULT_HOST = 'localhost';
var DEFAULT_PORT = '8080';

function main() {
  var argv, state, zk;

  optimist = optimist.usage('Usage: $0 -p [port] -h [hostname] --help');
  optimist = optimist['default']('p', DEFAULT_PORT);
  optimist = optimist['default']('h', DEFAULT_HOST);
  argv = optimist.argv;

  zk = zkUtil.getClient([ZK_URL]);
  zk.connect(function(err, session) {
    zk.volunteer('test', function(err, stats) {
      util.puts(':start:');
      state = stats;
    });
  });

  http.createServer(function(request, response) {
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify(state));
  }).listen(argv.p, function() {
    console.log('Listening on ' + argv.h + ':' + argv.p);
  });
}

main();
