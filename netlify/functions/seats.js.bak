// GET /.netlify/functions/seats  ->  the seven seats, read from the bundled seats.json
// The seat FILE is the seat. Editing the brief means editing the JSON, nothing else.
const seats = require("./seats.json");

exports.handler = async () => {
  const list = Object.keys(seats).map((id) => ({
    id,
    name: seats[id].name,
    title: seats[id].title,
    model: seats[id].model || null,
    portrait: seats[id].portrait || null,
  }));
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(list),
  };
};
