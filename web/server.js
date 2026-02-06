// web/server.js
const app = require("./app");

const PORT = Number(process.env.PORT) || 4001;

app.listen(PORT, () =>
  console.log(`Backend listening on http://localhost:${PORT}`)
);
