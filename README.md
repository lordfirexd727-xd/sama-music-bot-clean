# Sama Music Bot

A Discord music bot powered by **Node.js** and **Lavalink**, built for smooth voice-channel audio playback, queue handling, and multi-source streaming.

## Tech Stack

- **Runtime:** Node.js
- **Bot Framework:** Discord.js
- **Audio Engine:** Lavalink (`Lavalink.jar` + `application.yml`)
- **Plugins:** YouTube Plugin (`youtube-plugin`), LavaSrc (`lavasrc-plugin`)

## Project Structure

```text
SamaBot/
├── index.js            # Main bot entry point & Discord client setup
├── .env                # Bot token & Lavalink connection credentials
├── package.json        # Node dependencies
└── lavalink/
    ├── Lavalink.jar    # Lavalink audio server
    └── application.yml # Server, plugins, and OAuth configuration
