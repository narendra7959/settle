# Settle

Group decision rooms. One person makes a room and shares the link or QR code. Everyone adds options, votes, and sees the winner live. If the vote is tied, a wheel picks.

No accounts and no database. Rooms live in the server's memory and disappear when everyone has left.

## Voting styles

| Style | How people vote | Who wins |
|---|---|---|
| Pick one | Choose a single option | The most votes |
| Ranked choice | Put every option in order | Instant runoff: the last-place option drops out each round and its votes move to the next choice, until one option has more than half |
| Swipe | Yes or no on each option | The most yeses |
| Veto | Strike out up to 1–3 options | The fewest vetoes |

## Run it on your computer

You need [Node.js](https://nodejs.org) 18 or newer.

```
npm install
npm start
```

Open http://localhost:3000. To try it with several people, open the room link in a private window or on your phone (same Wi-Fi, using your computer's IP address).

Run the tests with `npm test`.

## Deploy to Render (free)

1. Put this folder in a GitHub repository.
2. In Render, choose **New → Blueprint** and pick the repository. Render reads `render.yaml` and sets everything up.
3. When the deploy finishes, your app is live at `https://<name>.onrender.com`.

On the free plan the server sleeps after 15 minutes without visitors. The next visitor waits about a minute while it wakes up, and any open rooms are gone. That suits this app, because rooms only last a few minutes.

## How it is built

- `server.js`: Express serves the page; Socket.IO carries live updates. All room rules (who can do what, and when) are enforced here.
- `lib/tally.js`: vote counting for the three styles.
- `public/`: the web page, written in plain JavaScript with no build step.
- `test/`: unit tests for the counting, and end-to-end tests that run real clients against the server.
