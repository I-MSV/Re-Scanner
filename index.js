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
  const buffer = await nbt.writeUncompressed(saveNbt.parsed);
  await writeFile(filePath, buffer);
};

function join(username, ip, port, version) {
  return new Promise(async (resolve, reject) => {
    let endTimeout = setTimeout(() => resolve(null), 6000);

    const bot = mineflayer.createBot({
      host: ip,
      port,
      version,
      username,
      auth: 'microsoft',
      profilesFolder: './'
    })

    bot.on('login', async () => {
      clearTimeout(endTimeout);
      bot.end();
      resolve(false);
      endTimeout = setTimeout(() => {
        bot.end();
        resolve(false);
      }, 3000);
    });
    bot.on('chat', (username, message) => { 
      if (bot.username != username) return;
      clearTimeout(endTimeout);
      bot.end();
      resolve(false);
    })

    // Log errors and kick reasons:
    bot.on('kicked', (reason) => {
      if (typeof reason == 'object') reason = JSON.stringify(reason);
      // console.log(`Kicked from ${ip}:${port}`, reason);
      if (reason.includes('You are not whitelisted on this server') || reason.includes('multiplayer.disconnect.not_whitelisted')) resolve(true);
      else resolve(null);
    });
    bot.on('error', (err) => {
      // console.log(`Error on ${ip}:${port} ${version}`, err);
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

    if (!server.name.includes("Re:SS")) return;

    const [ip, portStr] = server.ip.split(":");
    const port = portStr ? parseInt(portStr) : 25565;

    const slp = await ping(ip, port, 0);
    if (typeof slp == 'string' || slp?.version?.protocol == null) return;
    const version = versions.find(a => a.version == slp.version.protocol);
    if (version == null) return;
    let result;
    try {
      result = await join(username, ip, port, version.minecraftVersion);
    } catch (err) {
      console.log(`Bot error on ${ip}:${port}`, err);
      result = null;
    }
    while (result == 'retry') {
      try {
        result = await join(username, ip, port, version.minecraftVersion);
      } catch (err) {
        console.log(`Error on ${ip}:${port} ${slp.version.protocol}`, err);
        result = 'retry';
      }
      await new Promise(res => setTimeout(res, 1000));
    }

    if (result === true) {
      const index = serverList.indexOf(server);
      if (index !== -1) {
        if (config.removeWhitelisted) serverList.splice(index, 1);
        else server.entry.name.value += " Whitelisted";
      }
    }

    if (result != null) console.log(`${ip}:${port} ${version.minecraftVersion} ${result} ${(new Date().getTime() - lastResult) / 1000}s`);
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

// TODO: Create different checks with config
// Also scan with cracked version (can keep the name)
// Try multithreading the process possibly?
// instead of "starting..." add: "saving config"