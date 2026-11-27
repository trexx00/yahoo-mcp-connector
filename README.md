# yahoo-mcp-connector

A custom connector that lets Claude (and Duet) review and act on email in a Yahoo Mail account.
It is an [MCP](https://modelcontextprotocol.io) server that talks to Yahoo over IMAP (reading) and, later, SMTP (sending).

## Status

| Step | What | State |
|---|---|---|
| 1 | Yahoo app password | Done (kept by the account owner, never in this repo) |
| **2** | **Local, read-only server tested with MCP Inspector** | **This step** |
| 3 | Action tools: draft, send, move, flag, delete | Next |
| 4 | HTTPS transport and OAuth sign-in | |
| 5 | Deploy to AWS Lambda | |
| 6 | Add as a custom connector in Claude | |
| 7 | Test on desktop and in Duet | |

## What Step 2 can do

Three tools, all **read-only**. Folders are opened in IMAP read-only mode, so the server cannot change anything in the mailbox, and reading a message does not mark it as read.

| Tool | What it does |
|---|---|
| `list_folders` | Lists folders with total and unread counts |
| `search_mail` | Searches one folder by sender, recipient, subject, text, date range, unread or flagged. Newest first, up to 50 results |
| `read_message` | Reads one message by `uid`: headers, plain-text body, attachment names |

## How the code is organised

```
src/
  config.ts   Reads YAHOO_EMAIL and YAHOO_APP_PASSWORD from the environment (.env locally)
  imap.ts     Opens a TLS connection to imap.mail.yahoo.com:993, runs one job, closes it
  tools.ts    Defines the three tools and what they return
  index.ts    Starts the server over stdio, for local testing
```

`tools.ts` is kept separate from `index.ts` so Step 4 can reuse the same tools behind an HTTPS endpoint.

## What gets installed, and why

| Package | Why |
|---|---|
| `@modelcontextprotocol/sdk` | Official MCP toolkit: handles the protocol between Claude and this server |
| `imapflow` | IMAP client used to read the mailbox |
| `mailparser` | Turns a raw email into headers, text and attachment info |
| `zod` | Validates the inputs Claude sends to each tool |
| `dotenv` | Loads your `.env` file when running locally |
| `typescript`, `tsx`, `@types/*` | Dev only: compile and run TypeScript |

`npm install` puts these in `node_modules/`, which is ignored by Git.

## Run it on your computer

**1. Install Node.js 20 or newer.** Check with `node -v`. If it's missing, install the LTS version from [nodejs.org](https://nodejs.org).

**2. Get the code.**
```bash
git clone https://github.com/trexx00/yahoo-mcp-connector.git
cd yahoo-mcp-connector
git checkout step-2-readonly-server   # until this step is merged
npm install
```

**3. Add your Yahoo details to a local `.env` file.**
```bash
cp .env.example .env
```
Open `.env` in a text editor and fill in `YAHOO_EMAIL` and `YAHOO_APP_PASSWORD` (spaces in the app password are fine).
`.env` is listed in `.gitignore`, so Git will never upload it. Don't paste these values anywhere else.

**4. Open the MCP Inspector.**
```bash
npm run inspect
```
This downloads and starts the [MCP Inspector](https://github.com/modelcontextprotocol/inspector), which starts this server and opens a page in your browser. Then:
1. Click **Connect**.
2. Open the **Tools** tab and click **List Tools**. You should see the three tools.
3. Run `list_folders`. You should see your folders, such as `Inbox`, `Sent`, `Archive`.
4. Run `search_mail` with `unreadOnly` checked, or a `from` value.
5. Copy a `uid` from the results and run `read_message` with it.
6. Check in Yahoo Mail that the message you read is still unread.

Press `Ctrl+C` in the terminal to stop.

## Troubleshooting

| Error | Likely cause |
|---|---|
| `Missing YAHOO_EMAIL or YAHOO_APP_PASSWORD` | `.env` is missing or a value is empty |
| `AUTHENTICATIONFAILED` / `Invalid credentials` | Wrong app password, or using your normal Yahoo password. Generate a new app password |
| `Mailbox doesn't exist` | Folder name mismatch. Use the exact `path` from `list_folders` |
| `getaddrinfo ENOTFOUND` | No internet, or a network that blocks port 993 |

## Security notes

- No credentials are stored in the code or the repo.
- Email contents are written by whoever sent them, and can contain text that tries to instruct an AI. `read_message` labels its output as untrusted data. Later steps will add confirmation before sending or deleting.
- You can revoke the app password at any time in Yahoo Account Security, which cuts off this server immediately.
