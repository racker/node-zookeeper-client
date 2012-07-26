#!/usr/bin/env node
var async = require('async');
var logmagic = require('logmagic');

var instruments = require('rackspace-shared-utils/lib/instruments');
var ZkClient = require('../lib/client').ZkClient;

var ZK_URL = '127.0.0.1:22181';

logmagic.route('__root__', logmagic.DEBUG, 'console');

function run(lockName, releaseAfter) {
  var zk = new ZkClient([ZK_URL]);

  async.series([
    zk.connect.bind(zk),
    zk.acquireLock.bind(zk, lockName, 'txn-1'),

    function releaseLock(callback) {
      setTimeout(function releaseLock() {
        zk.unlock(lockName, function(err) {
          console.log('Lock released');
          callback();
        });
      }, releaseAfter);
    }
  ],

  function(err) {
    instruments.shutdown();
    zk.close(function() {
      if (err) {
        throw err;
      }

      console.log('Done, exiting...');
    });
  });
}

run(process.argv[2], parseInt(process.argv[3], 10));
