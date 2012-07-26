var path = require('path');

var spawnChild = require('rackspace-shared-utils/lib/misc').spawnChild;

exports.spawnZookeeperElectionServer = function spawnZookeeperElectionServer(port) {
  var server, cacheKey, readyMessage, script;
  port = port || misc.getRandomInt(2000, 65535);

  cacheKey = 'ele-zookeeper-election-server-' + port;
  readyMessage = ':start:';
  script = path.join(__dirname, 'zk-election-helper.js')

  server = spawnChild(script,
                      ['-p', port],
                      null, cacheKey, readyMessage,
                      true, true);
  server.__port = port;

  return server;
}
