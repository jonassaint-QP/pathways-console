(function(root){
  async function readChatStream(response, onDelta){
    if(!response.ok){
      var error = await response.json();
      throw new Error(error.message || "The chat request failed (" + response.status + ").");
    }
    if(!response.body || !/^application\/x-ndjson\b/i.test(response.headers.get("content-type") || "")){
      throw new Error("The server did not return a chat stream.");
    }
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "", reply = "", completed = null;
    function consume(line){
      if(!line.trim()) return;
      if(completed) throw new Error("Unexpected data after the final chat event.");
      var event = JSON.parse(line);
      if(event.type === "error") throw new Error(event.message || "The answer is incomplete.");
      if(event.type === "delta" && typeof event.text === "string"){
        reply += event.text;
        onDelta(reply);
      } else if(event.type === "done" && typeof event.reply === "string" && event.reply.trim()){
        if(event.reply !== reply.trim()) throw new Error("The answer did not arrive in full.");
        completed = event;
      } else {
        throw new Error("The server returned an invalid chat event.");
      }
    }
    try {
      while(true){
        var chunk = await reader.read();
        if(chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var end;
        while((end = buffer.indexOf("\n")) !== -1){
          consume(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
        }
      }
      buffer += decoder.decode();
      if(buffer.trim()) throw new Error("The stream ended mid-event. The answer is incomplete.");
      if(!completed) throw new Error("The stream ended before the answer was complete.");
      return completed;
    } finally {
      try { await reader.cancel(); } finally { reader.releaseLock(); }
    }
  }
  if(typeof module !== "undefined" && module.exports) module.exports = { readChatStream: readChatStream };
  else root.readChatStream = readChatStream;
})(typeof window !== "undefined" ? window : globalThis);
