# Block Platform

A tiny multiplayer 3D block game: explore a generated world, then break and place blocks together.

- Main menu, game menu, nametags and text chat; the host can **Open World** to get a join code.
- Terrain is generated from a **seed**: oceans, beaches, deserts, grassy hills, rocky mountains and snowy peaks.
- Blocks: grass, dirt, stone, sand, wood, wood planks, leaves, cobblestone, snow (plus water and bedrock).
- Oak **trees** grow in forests and scattered through grassland.
- The world is endless on x/z (up to ±30,000 blocks) and streams in around you.

## Project layout

    server.js            Node server (Express + WebSocket)
    public/index.html    The game (Three.js client)
    public/worldgen.js   Seeded world generator, shared by the server and the browser
    package.json
    render.yaml

Keep `index.html` and `worldgen.js` together: the browser loads `worldgen.js` directly and the server
`require`s it. The `public/` folder is the intended place, but if you upload everything flat (all files
next to `server.js`) the server detects that and still works. Both run the same code, so the same seed gives the same world everywhere. Only the seed and
player changes are sent over the network, not the terrain.

## Run locally

    npm install
    npm start

Open http://localhost:3000 in two browser tabs: create a world in one, press Esc and click Open World,
then join from the other tab with the code.

## How playing together works

1. **Main menu**: type your name, then either
   - **Create world** (leave the seed empty for a random world), or
   - enter a friend's 6-character code and press **Join**.
2. Press **Esc** in the game to open the **Game menu**. As the host, click **Open World**: a code such as
   `K7MQ2X` appears. Send it to your friends; they type it into the *Join a friend* box on the main menu.
3. **Close World** stops new players from joining (people already inside stay). Only the host can open or
   close the world. If the host leaves, the player who has been there longest becomes the new host.
4. Everyone gets a **nametag** floating above their head. Press **T** (or Enter) to **chat**; Enter sends,
   Esc cancels. Join/leave messages also appear in the chat.

Each world has its own seed (shown in the Game menu) and is discarded when the last player leaves.
Up to 20 worlds with 12 players each can run at once.

## Deploy (GitHub + Render)

1. Create a new GitHub repo and push this folder to it:

       git init
       git add .
       git commit -m "Block Platform"
       git branch -M main
       git remote add origin https://github.com/YOUR_USER/block-platform.git
       git push -u origin main

2. On https://render.com: New + > Web Service > connect the repo.
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free
   (Or choose New + > Blueprint, which reads `render.yaml` automatically.)

3. When the deploy finishes, open your `.onrender.com` URL and share it.

## Controls

W A S D move, Space jump (or swim up), Shift run, left click break, right click place,
1-9 or mouse wheel to pick a block, Esc to release the mouse.

## Notes

- Terrain is regenerated from the seed, so only player edits live in server memory (capped at 40,000 changes
  per world). A world disappears when its last player leaves, and everything resets when the server
  restarts or redeploys.
- Render's free tier sleeps after ~15 minutes without traffic; the first visit afterwards takes ~30-60 s to wake up.
- If the game runs slowly on a weak computer, lower `RENDER_DIST` at the top of the script in `public/index.html`.
- Desktop only (keyboard + mouse).
