
require("dotenv").config();

const axios = require("axios");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const { LavalinkManager } = require("lavalink-client");

// -------------------- ENVIRONMENT --------------------

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  JAMENDO_CLIENT_ID,
  LAVALINK_PASSWORD,
} = process.env;

if (
  !DISCORD_TOKEN ||
  !DISCORD_CLIENT_ID ||
  !JAMENDO_CLIENT_ID ||
  !LAVALINK_PASSWORD
) {
  throw new Error("Missing environment variables. Check your .env file.");
}

// -------------------- DISCORD CLIENT --------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// -------------------- LAVALINK --------------------

client.lavalink = new LavalinkManager({
  nodes: [
    {
      id: "Main Node",
      host: "localhost",
      port: 2333,
      authorization: LAVALINK_PASSWORD,
    },
  ],

  sendToShard: (guildId, payload) => {
    const guild = client.guilds.cache.get(guildId);
    if (guild) guild.shard.send(payload);
  },

  client: {
    id: DISCORD_CLIENT_ID,
    username: "Music Bot",
  },

  autoSkip: false,
});

client.on("raw", (data) => {
  client.lavalink.sendRawData(data);
});

// -------------------- DATA --------------------

const songCache = new Map();
const queues = new Map();
const currentTracks = new Map();
const advancing = new Set();

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// -------------------- AUDIUS SEARCH --------------------

async function searchAudius(query) {
  try {
    const response = await axios.get(
      "https://api.audius.co/v1/tracks/search",
      {
        params: {
          query,
          limit: 10,
        },
        timeout: 10000,
      }
    );

    const tracks = response.data?.data || [];

    return tracks
      .filter((track) => track.id)
      .map((track) => ({
        id: `audius:${track.id}`,
        name: track.title || "Unknown track",
        artist: track.user?.name || "Unknown artist",
        audio: `https://api.audius.co/v1/tracks/${track.id}/stream`,
        image: track.artwork?.["480x480"] || null,
        duration: Number(track.duration) || 0,
        source: "Audius",
      }));
  } catch (error) {
    console.error(
      "Audius search failed:",
      error.response?.status || error.message
    );
    return [];
  }
}

// -------------------- JAMENDO SEARCH --------------------

function getSearchQueries(query) {
  const q = query.trim();

  return [
    q,
    `${q} Hindi`,
    `${q} Indian`,
    `${q} Indian hip hop`,
  ].filter((value, index, array) => array.indexOf(value) === index);
}

async function searchJamendo(query) {
  const results = [];
  const seen = new Set();

  for (const searchTerm of getSearchQueries(query)) {
    try {
      const response = await axios.get(
        "https://api.jamendo.com/v3.0/tracks/",
        {
          params: {
            client_id: JAMENDO_CLIENT_ID,
            format: "json",
            limit: 10,
            search: searchTerm,
            audioformat: "mp31",
          },
          timeout: 8000,
        }
      );

      const tracks = response.data?.results || [];

      for (const track of tracks) {
        if (!track.id || !track.audio) continue;

        const id = `jamendo:${track.id}`;
        if (seen.has(id)) continue;

        seen.add(id);

        results.push({
          id,
          name: track.name || "Unknown track",
          artist: track.artist_name || "Unknown artist",
          audio: track.audio,
          image: track.album_image || null,
          duration: Number(track.duration) || 0,
          source: "Jamendo",
        });
      }

      if (results.length >= 10) break;
    } catch (error) {
      console.error(
        `Jamendo search failed for "${searchTerm}":`,
        error.response?.status || error.message
      );
    }
  }

  return results;
}

// -------------------- COMBINED SEARCH --------------------

async function searchTracks(query) {
  const [audiusTracks, jamendoTracks] = await Promise.all([
    searchAudius(query),
    searchJamendo(query),
  ]);

  const combined = [
    ...audiusTracks.slice(0, 5),
    ...jamendoTracks.slice(0, 5),
  ];

  for (const track of combined) {
    songCache.set(track.id, track);
  }

  return combined;
}

// -------------------- QUEUE HELPERS --------------------

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, []);
  }

  return queues.get(guildId);
}

function formatDuration(seconds) {
  if (!seconds || !Number.isFinite(seconds)) return "Unknown";

  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);

  return `${mins}:${String(secs).padStart(2, "0")}`;
}

// -------------------- PLAYER / VOICE CONNECTION --------------------

async function getLavalinkPlayer(interaction) {
  const guildId = interaction.guildId;
  const voiceChannel = interaction.member?.voice?.channel;

  if (!voiceChannel) {
    throw new Error("Please join a voice channel first.");
  }

  if (!client.lavalink.useable) {
    throw new Error(
      "Lavalink node is not ready. Check that your Lavalink server is running."
    );
  }

  let player = client.lavalink.players.get(guildId);

  if (!player) {
    player = client.lavalink.createPlayer({
      guildId,
      voiceChannelId: voiceChannel.id,
      textChannelId: interaction.channelId,
      selfDeaf: true,
      volume: 100,
    });
  } else {
    if (player.voiceChannelId !== voiceChannel.id) {
      player.voiceChannelId = voiceChannel.id;
    }

    player.textChannelId = interaction.channelId;
  }

  if (!player.connected) {
    await player.connect();
  }

  // Give Discord and Lavalink time to complete the voice handshake.
  for (let attempt = 0; attempt < 50; attempt++) {
    if (player.connected) break;
    await sleep(200);
  }

  if (!player.connected) {
    throw new Error(
      "Voice connection timed out. Check the bot's Connect/Speak permissions and Lavalink logs."
    );
  }

  return player;
}

// -------------------- PLAY TRACK --------------------

async function playTrack(guildId, track) {
  const player = client.lavalink.players.get(guildId);

  if (!player) {
    throw new Error("Lavalink player not found. Use /join first.");
  }

  if (!track?.audio || !/^https?:\/\//i.test(track.audio)) {
    throw new Error("This track does not have a valid audio URL.");
  }

  if (!client.lavalink.useable) {
    throw new Error("Lavalink node is disconnected.");
  }

  const result = await player.search(
    {
      query: track.audio,
      source: "http",
    },
    client.user
  );

  const loadedTrack = result?.tracks?.[0];

  if (!loadedTrack?.encoded) {
    throw new Error(
      `Lavalink could not load this ${track.source} stream.`
    );
  }

  // Recheck voice state before sending the track to Lavalink.
  if (!player.connected) {
    await player.connect();

    for (let attempt = 0; attempt < 50; attempt++) {
      if (player.connected) break;
      await sleep(200);
    }
  }

  if (!player.connected) {
    throw new Error("Voice connection is not ready. Try /join again.");
  }

  await player.play({
    track: {
      encoded: loadedTrack.encoded,
    },
  });

  currentTracks.set(guildId, track);
}

// -------------------- PLAY NEXT TRACK --------------------

async function playNext(guildId) {
  if (advancing.has(guildId)) return;

  advancing.add(guildId);

  try {
    const queue = getQueue(guildId);

    while (queue.length > 0) {
      const nextTrack = queue.shift();

      try {
        await playTrack(guildId, nextTrack);

        console.log(
          `Now playing: ${nextTrack.artist} - ${nextTrack.name} [${nextTrack.source}]`
        );

        return;
      } catch (error) {
        console.error(
          `Track playback failed (${nextTrack.source}):`,
          error.message
        );
      }
    }

    currentTracks.delete(guildId);
    console.log("The queue is empty or no queued track could be played.");
  } finally {
    advancing.delete(guildId);
  }
}

// -------------------- SLASH COMMANDS --------------------

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check bot latency"),

  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join your voice channel"),

  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Search Audius and Jamendo and play a track")
    .addStringOption((option) =>
      option
        .setName("song")
        .setDescription("Search for a song or artist")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the music queue"),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current track"),

  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause the current track"),

  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume playback"),

  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove a queued track")
    .addIntegerOption((option) =>
      option
        .setName("position")
        .setDescription("Position in the queue, starting at 1")
        .setRequired(true)
        .setMinValue(1)
    ),
].map((command) => command.toJSON());

// -------------------- REGISTER COMMANDS --------------------

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  await rest.put(
    Routes.applicationCommands(DISCORD_CLIENT_ID),
    { body: commands }
  );

  console.log("Slash commands registered successfully.");
}

// -------------------- AUTOCOMPLETE --------------------

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isAutocomplete()) return;
  if (interaction.commandName !== "play") return;

  try {
    const query = interaction.options.getFocused().trim();

    if (query.length < 2) {
      return interaction.respond([]);
    }

    const tracks = await searchTracks(query);

    const choices = tracks.slice(0, 25).map((track) => ({
      name: `${track.artist} - ${track.name} [${track.source}]`.slice(0, 100),
      value: track.id,
    }));

    await interaction.respond(choices);
  } catch (error) {
    console.error("Autocomplete error:", error.message);
    await interaction.respond([]).catch(() => {});
  }
});

// -------------------- COMMAND HANDLER --------------------

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    if (commandName === "ping") {
      return interaction.reply(`Pong! ${client.ws.ping}ms`);
    }

    if (!interaction.inGuild()) {
      return interaction.reply({
        content: "Please use this command in a server.",
        ephemeral: true,
      });
    }

    // JOIN
    if (commandName === "join") {
      await interaction.deferReply();
      await getLavalinkPlayer(interaction);

      return interaction.editReply(
        "Connected to your voice channel!"
      );
    }

    // PLAY
    if (commandName === "play") {
      await interaction.deferReply();

      const input = interaction.options.getString("song", true).trim();

      let track = songCache.get(input);

      if (!track) {
        const tracks = await searchTracks(input);
        track = tracks[0];
      }

      if (!track) {
        return interaction.editReply(
          "No matching track found on Audius or Jamendo. Try another search."
        );
      }

      await getLavalinkPlayer(interaction);

      const guildId = interaction.guildId;
      const queue = getQueue(guildId);

      if (currentTracks.has(guildId)) {
        queue.push(track);

        return interaction.editReply(
          `Added to queue: **${track.artist} - ${track.name}** [${track.source}]`
        );
      }

      await playTrack(guildId, track);

      return interaction.editReply(
        `Now playing: **${track.artist} - ${track.name}** [${track.source}]`
      );
    }

    // QUEUE
    if (commandName === "queue") {
      const queue = getQueue(interaction.guildId);
      const current = currentTracks.get(interaction.guildId);
      const lines = [];

      if (current) {
        lines.push(
          `▶️ **Now playing:** ${current.artist} - ${current.name} [${current.source}]`
        );
      }

      if (queue.length) {
        lines.push(
          ...queue.slice(0, 10).map(
            (track, index) =>
              `**${index + 1}.** ${track.artist} - ${track.name} [${track.source}] (${formatDuration(track.duration)})`
          )
        );
      }

      return interaction.reply(
        lines.length ? lines.join("\n") : "The queue is empty."
      );
    }

    // SKIP
    if (commandName === "skip") {
      const player = client.lavalink.players.get(interaction.guildId);

      if (!player || !currentTracks.has(interaction.guildId)) {
        return interaction.reply("No track is currently playing.");
      }

      currentTracks.delete(interaction.guildId);
      await interaction.reply("Skipping the current track...");

      await player.stopPlaying(false);
      await playNext(interaction.guildId);

      return;
    }

    // PAUSE
    if (commandName === "pause") {
      const player = client.lavalink.players.get(interaction.guildId);

      if (!player || !currentTracks.has(interaction.guildId)) {
        return interaction.reply("No track is currently playing.");
      }

      await player.pause();
      return interaction.reply("Playback paused.");
    }

    // RESUME
    if (commandName === "resume") {
      const player = client.lavalink.players.get(interaction.guildId);

      if (!player || !currentTracks.has(interaction.guildId)) {
        return interaction.reply("No track is currently playing.");
      }

      await player.resume();
      return interaction.reply("Playback resumed.");
    }

    // REMOVE
    if (commandName === "remove") {
      const queue = getQueue(interaction.guildId);
      const position = interaction.options.getInteger("position", true);

      if (position > queue.length) {
        return interaction.reply(
          "There is no queued track at that position."
        );
      }

      const [removed] = queue.splice(position - 1, 1);

      return interaction.reply(
        `Removed from queue: **${removed.artist} - ${removed.name}**`
      );
    }
  } catch (error) {
    console.error(`/${commandName} failed:`, error);

    const message = `Error: ${error.message || "Something went wrong."}`;

    if (interaction.deferred) {
      return interaction.editReply(message).catch(() => {});
    }

    if (interaction.replied) {
      return interaction.followUp({
        content: message,
        ephemeral: true,
      }).catch(() => {});
    }

    return interaction.reply({
      content: message,
      ephemeral: true,
    }).catch(() => {});
  }
});

// -------------------- LAVALINK EVENTS --------------------

client.lavalink.on("trackEnd", async (player, track, payload) => {
  const reason = payload?.reason;

  // Manual skips are handled by /skip.
  if (reason && reason !== "finished") return;

  const guildId = player.guildId;
  currentTracks.delete(guildId);

  await playNext(guildId);
});

client.lavalink.on("trackError", async (player, track, payload) => {
  const guildId = player.guildId;

  console.error(
    "Track error:",
    payload?.exception?.message || payload?.error || payload
  );

  currentTracks.delete(guildId);
  await playNext(guildId);
});

client.lavalink.on("trackStuck", async (player, track, payload) => {
  console.error("Track stuck:", payload);

  const guildId = player.guildId;
  currentTracks.delete(guildId);

  try {
    await player.stopPlaying(false);
  } catch (error) {
    console.error("Failed to stop stuck track:", error.message);
  }

  await playNext(guildId);
});

client.lavalink.on("nodeConnect", (node) => {
  console.log(`Lavalink connected: ${node.id}`);
});

client.lavalink.on("nodeError", (node, error) => {
  console.error(`Lavalink node error (${node.id}):`, error);
});

// -------------------- STARTUP --------------------

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await client.lavalink.init({
      id: client.user.id,
      username: client.user.username,
    });

    console.log("Lavalink manager initialized.");
  } catch (error) {
    console.error("Lavalink initialization failed:", error);
  }
});

(async () => {
  try {
    await registerCommands();
    await client.login(DISCORD_TOKEN);
  } catch (error) {
    console.error("Startup failed:", error);
  }
})();
