const fs = require('fs');
const path = require('path')
const mineflayer = require('mineflayer');
const ping = require('./ping.js');
const nbt = require('prismarine-nbt');
const util = require('util');
const pLimit = require('p-limit');

const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);

const configFilePath = path.join(__dirname, 'config.json');

let serverFilePath;
let config;
let saveNbt;
let serverList;
let serversToScan;
let exiting;
let cancel;

async function loadConfig() {
  const buffer = await readFile(configFilePath)
  return JSON.parse(buffer);
}

async function loadServerList() {
  serverFilePath = path.join(config.saveDirectory, 'servers.dat');
  const buffer = await readFile(serverFilePath);
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
  await writeFile(serverFilePath, buffer);
};

function join(username, auth, ip, port, version) {
  return new Promise(async (resolve, reject) => {
    let endTimeout = setTimeout(() => resolve(null), 6000);
    let bot;

    try {
      bot = mineflayer.createBot({
        host: ip,
        port,
        version,
        username,
        auth,
        profilesFolder: './'
      })
    }
    catch (err) {
      resolve('unsupported');
      return;
    }

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
  console.log("Loading config");
  config = await loadConfig();
  console.log("Loading server list");
  serverList = await loadServerList();
  serversToScan = serverList;
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
      //console.log(`Bot error on ${ip}:${port}`, err);
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

    //they have different logics, cracked deletes non cracked servers for example
    if (auth === "offline") {
      if (result === false && intent === true) toDelete.add(server);
      if (result === true && intent === false) {
        if (server.entry.name.value.includes(mode)) return;
        server.entry.name.value += ` ${mode}`;
      }
    }
    else {
      if (result === true) {
        if (intent === true) toDelete.add(server);
        else {
          if (server.entry.name.value.includes(mode)) return;
          server.entry.name.value += ` ${mode}`;
        }
      }
    }
    if (result === 'unsupported') {
      if (config.deleteUnsupported === true) toDelete.add(server);
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
  serversToScan = serverList.filter(server => server.name.includes('Re:SS'));
  
  if (config.ignoreRescanned) {
    serversToScan = serversToScan.filter(server => !server.name.includes('whitelisted') && !server.name.includes('cracked'))
  }

  const serverAmount = serversToScan.length;
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
      if (output !== "") output += " | ";
      output += `Cracked scanned ${crackedScanned}/${serverAmount}`;
    }

    console.log(output);
  }

  if (config.crackedIntent != null) {
    crackedTasks = serversToScan.map(server => limit(async() => {
      if (cancel) return;
      const result = await check(server, "cracked", config.crackedIntent);
      crackedScanned++;
      updateScanLog();
      return result;
    }));
  }

  if (config.whitelistIntent != null) {
    for (const server of serversToScan) {
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