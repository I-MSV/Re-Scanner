const fs = require('fs');
const path = require('path')
const mineflayer = require('mineflayer');
const ping = require('./ping.js');
const nbt = require('prismarine-nbt');
const util = require('util');
const config = require('./config.json');
const pLimit = require('p-limit');

const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);

const filePath = path.join(config.saveDirectory, 'servers.dat');

let saveNbt;
let serverList;
let exiting;
let cancel;

async function loadServerList() {
  const buffer = await readFile(filePath);
  const data = await nbt.parse(buffer);
  saveNbt = data;

  const servers = data.parsed.value.servers.value.value;
  return servers.map(entry => ({
    ip: entry.ip.value,
    name: entry.name.value,
    entry
  }));
}

async function saveServerList(serverList) {
  if (!saveNbt) return;

  saveNbt.parsed.value.servers.value.value = serverList.map(server => server.entry);
  const buffer = nbt.writeUncompressed(saveNbt.parsed);
  await writeFile(filePath, buffer);
};

function join(username, auth, ip, port, version) {
  return new Promise(async (resolve, reject) => {
    let endTimeout = setTimeout(() => resolve(null), 6000);

    const bot = mineflayer.createBot({
      host: ip,
      port,
      version,
      username,
      auth,
      profilesFolder: './'
    })

    bot.on('login', async () => {
      bot.end();
      if (auth === 'offline') {
        resolve(true);
        return;
      }

      clearTimeout(endTimeout);
      endTimeout = setTimeout(() => {
        resolve(false);
      }, 3000);
    });

    bot.on('kicked', (reason) => {
      if (typeof reason == 'object') reason = JSON.stringify(reason);
      //console.log(`Kicked from ${ip}:${port}`, reason);

      if (auth === 'microsoft') {
        if (reason.includes('You are not whitelisted on this server') || reason.includes('multiplayer.disconnect.not_whitelisted')) {
          resolve(true);
          return;
        };
      }
      else {
        if (reason.includes('Failed to verify username!') || reason.includes('multiplayer.disconnect.unverified_username')) {
          resolve(false);
          return;
        };
        //maybe some very smart person would turn on whitelist but on a cracked server...
        if (reason.includes('You are not whitelisted on this server') || reason.includes('multiplayer.disconnect.not_whitelisted')) {
          resolve(true);
          return;
        }
      }

      resolve(null);
    });

    bot.on('error', (err) => {
      //console.log(`Error on ${ip}:${port} ${version}`, err);
      if (err.message.includes('RateLimiter disallowed request') || err.message.includes('Failed to obtain profile data')) {
        resolve('retry');
        return;
      };
      if (err.message.includes('multiplayer.disconnect.outdated_client') || err.message.includes('ECONNRESET')) resolve('unsupported');
      else resolve(null);
    });
  });
}

lastResult = new Date().getTime();
async function scan() {
  console.log("Loading server list");
  serverList = await loadServerList();
  const toDelete = new Set();

  console.log("Fetching versions");
  const versions = await (await fetch('https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc/common/protocolVersions.json')).json();

  async function check(server, mode, intent) {
    const username = config.username;
    const serverIndex = serverList.indexOf(server);

    const [ip, portStr] = server.ip.split(":");
    const port = portStr ? parseInt(portStr) : 25565;

    const slp = await ping(ip, port, 0);
    if (typeof slp == 'string' || slp?.version?.protocol == null) {
      if (config.deleteOffline) toDelete.add(server);
      return;
    };

    const version = versions.find(a => a.version == slp.version.protocol);
    if (version == null) return;

    let result;
    const auth = mode === "cracked" ? "offline" : "microsoft";

    try {
      result = await join(username, auth, ip, port, version.minecraftVersion);
    } catch (err) {
      console.log(`Bot error on ${ip}:${port}`, err);
      result = null;
    }
    while (result == 'retry') {
      try {
        result = await join(username, auth, ip, port, version.minecraftVersion);
      } catch (err) {
        //console.log(`Error on ${ip}:${port} ${slp.version.protocol}`, err);
        result = 'retry';
      }
      await new Promise(res => setTimeout(res, 1000));
    }

    if (result === true) {
      if (intent === true) {
        toDelete.add(server);
      }
      else {
        if (server.entry.name.value.includes(mode)) return;
        server.entry.name.value += ` ${mode}`;
      }
    }

    if (result === 'unsupported') {
      if (server.entry.name.value.includes("UNSUPPORTEDVERSION")) return;
      else server.entry.name.value += " UNSUPPORTEDVERSION";
      return;
    }

    //not sure if it ever gets here, will leave it just in case
    if (result == null && config.deleteOffline) {
      toDelete.add(server);
    }
    //if (result != null) console.log(`${ip}:${port} ${version.minecraftVersion} ${result} ${(new Date().getTime() - lastResult) / 1000}s`);
  }

  //filter before scanning serverlist
  serverList = serverList.filter(server => server.name.includes('Re:SS'));
  
  if (config.ignoreRescanned) {
    serverList = serverList.filter(server => !server.name.includes('Whitelisted') && !server.name.includes('Cracked'))
  }

  const serverAmount = serverList.length;
  let crackedScanned = 0;
  let whitelistScanned = 0;

  let crackedTasks = [];
  const limit = pLimit(5);

  function updateScanLog() {
    let output = "";
    if (config.whitelistIntent != null) {
      output += `Whitelist scanned ${whitelistScanned}/${serverAmount}`;
    }
    if (config.crackedIntent != null) {
      output += `\nCracked scanned ${crackedScanned}/${serverAmount}`;
    }

    console.log(output);
  }

  if (config.crackedIntent != null) {
    crackedTasks = serverList.map(server => limit(async() => {
      if (cancel) return;
      const result = await check(server, "cracked", config.crackedIntent);
      crackedScanned++;
      updateScanLog();
      return result;
    }));
  }

  if (config.whitelistIntent != null) {
    for (const server of serverList) {
      if (cancel) break;
      await check(server, "whitelisted", config.whitelistIntent);
      whitelistScanned++;

      updateScanLog();
    }
  }

  await Promise.all(crackedTasks);
  
  serverList = serverList.filter(server => !toDelete.has(server));

  console.log("Saving server list");
  await saveServerList(serverList);
  console.log("Done!");
  process.exit();
}

function exit() {
  //just to prevent "Cancelling" overriding the other text probably
  if (exiting) return;
  exiting = true;

  console.log("Cancelling");
  cancel = true;
}

//on any stdin
process.stdin.on('data', exit)

scan();