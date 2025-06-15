const fs = require('fs');
const path = require('path')
const mineflayer = require('mineflayer');
const ping = require('./ping.js');
const nbt = require('prismarine-nbt');
const util = require('util');
const config = require('./config.json');

const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);

const filePath = path.join(config.saveDirectory, 'servers.dat');

let saveNbt;

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
      resolve(false);
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
          resolve(true);
          return;
        };
        //maybe some very smart person would turn on whitelist but on a cracked server...
        if (reason.includes('You are not whitelisted on this server') || reason.includes('multiplayer.disconnect.not_whitelisted')) {
          resolve(false);
          return;
        }
      }

      resolve(null);
    });

    bot.on('error', (err) => {
      //console.log(`Error on ${ip}:${port} ${version}`, err);
      if (err.message.includes('RateLimiter disallowed request') || err.message.includes('Failed to obtain profile data')) resolve('retry');
      else resolve(null);
    });
  });
}

lastResult = new Date().getTime();
async function scan() {
  console.log("Loading server list");
  const serverList = await loadServerList();

  console.log("Fetching versions");
  const versions = await (await fetch('https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc/common/protocolVersions.json')).json();

  async function check(server) {
    const username = config.username;
    const serverIndex = serverList.indexOf(server);

    if (!server.name.includes("Re:SS")) return;

    const [ip, portStr] = server.ip.split(":");
    const port = portStr ? parseInt(portStr) : 25565;

    const slp = await ping(ip, port, 0);
    if (typeof slp == 'string' || slp?.version?.protocol == null) {
      if (config.deleteOffline) serverList.splice(serverIndex, 1);
      return;
    };
    const version = versions.find(a => a.version == slp.version.protocol);
    if (version == null) return;

    let noncrackedResult;
    let whitelistResult;

    if (config.crackedIntent != null) {
      try {
        noncrackedResult = await join(username, 'offline', ip, port, version.minecraftVersion);
      } catch (err) {
        console.log(`Bot error on ${ip}:${port}`, err);
        whitelistResult = null;
      }
      while (noncrackedResult == 'retry') {
        try {
          noncrackedResult = await join(username, ip, port, version.minecraftVersion);
        } catch (err) {
          console.log(`Error on ${ip}:${port} ${slp.version.protocol}`, err);
          noncrackedResult = 'retry';
        }
        await new Promise(res => setTimeout(res, 1000));
      }
    }

    if (noncrackedResult === true && config.whitelistIntent === true) {
      serverList.splice(serverIndex, 1);
    }

    if (noncrackedResult === false && config.whitelistIntent === false) {
      if (server.entry.name.value.includes("Cracked")) return;
      server.entry.name.value += " Cracked";
    }

    if (config.whitelistIntent == null) return;
    
    try {
      whitelistResult = await join(username, 'microsoft', ip, port, version.minecraftVersion);
    } catch (err) {
      console.log(`Bot error on ${ip}:${port}`, err);
      whitelistResult = null;
    }
    while (whitelistResult == 'retry') {
      try {
        whitelistResult = await join(username, ip, port, version.minecraftVersion);
      } catch (err) {
        console.log(`Error on ${ip}:${port} ${slp.version.protocol}`, err);
        whitelistResult = 'retry';
      }
      await new Promise(res => setTimeout(res, 1000));
    }

    if (whitelistResult === true) {
      if (config.whitelistIntent) serverList.splice(serverIndex, 1);
      if (server.entry.name.value.includes("Whitelisted")) return;
      else server.entry.name.value += " Whitelisted";
    }

    //not sure if it ever gets here, will leave it just in case
    if (noncrackedResult == null && whitelistResult == null && config.deleteOffline) {
      serverList.splice(serverIndex, 1);
    }
    //if (result != null) console.log(`${ip}:${port} ${version.minecraftVersion} ${result} ${(new Date().getTime() - lastResult) / 1000}s`);
  }

  const serverCount = serverList.length;
  //i know i could just use array method i dont care...
  let i = 1;
  for (const server of serverList) {
    console.log(`Checking server ${i}/${serverCount}`);
    await check(server);
    i++;
  }

  if (config.repeat) setTimeout(scan, 0);
  else {
    console.log("Saving server list");
    await saveServerList(serverList);
    console.log("Done!");
    process.exit();
  }
}

scan();

// TODO:
// Try multithreading the process possibly?