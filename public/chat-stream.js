(function(root){
  // The console has no folder field, so the folder arrives in the URL:
  //   /?folder=<drive folder id>
  // It is remembered once seen. A bare visit sends no folder and the seat stays text-only.
  var KEY="qp.folder", folderId="";
  try{
    var m=/[?&]folder=([A-Za-z0-9_-]{3,200})/.exec(root.location.search||"");
    if(m){ folderId=m[1]; try{root.localStorage.setItem(KEY,folderId);}catch(e){} }
    else { folderId=root.localStorage.getItem(KEY)||""; }
  }catch(e){ folderId=""; }

  // Bind the folder onto the chat request. Only chat calls, only to add one field.
  var CHAT=/\/functions\/chat(\?|$)|\/api\/chat(\?|$)/, inner=root.fetch;
  if(typeof inner==="function") root.fetch=function(input,init){
    try{
      var url=typeof input==="string"?input:(input&&input.url)||"";
      if(folderId&&CHAT.test(url)&&init&&typeof init.body==="string"){
        var p=JSON.parse(init.body);
        if(p&&p.seatId&&!p.folderId){ p.folderId=folderId; init=Object.assign({},init,{body:JSON.stringify(p)}); }
      }
    }catch(e){}
    return inner.call(this,input,init);
  };

  // Tool events are progress, not answer text: collected and reported, never added to the
  // reply, so the final-event comparison stays like for like.
  async function readChatStream(response,onDelta,onTool){
    if(!response.ok){ var e=await response.json(); throw new Error(e.message||("The chat request failed ("+response.status+").")); }
    if(!response.body||!/^application\/x-ndjson\b/i.test(response.headers.get("content-type")||"")) throw new Error("The server did not return a chat stream.");
    var reader=response.body.getReader(), dec=new TextDecoder(), buf="", reply="", done=null, actions=[];
    function take(line){
      if(!line.trim()) return;
      if(done) throw new Error("Unexpected data after the final chat event.");
      var ev=JSON.parse(line);
      if(ev.type==="error") throw new Error(ev.message||"Hey, it's taking a little longer. Give me a few minutes.");
      if(ev.type==="delta"&&typeof ev.text==="string"){ reply+=ev.text; onDelta(reply); }
      else if(ev.type==="tool"){ actions.push(ev); if(typeof onTool==="function") onTool(ev,actions); }
      else if(ev.type==="done"&&typeof ev.reply==="string"&&ev.reply.trim()){
        if(ev.reply!==reply.trim()) throw new Error("The answer did not arrive in full.");
        done=ev;
      } else throw new Error("The server returned an invalid chat event.");
    }
    try{
      while(true){
        var c=await reader.read(); if(c.done) break;
        buf+=dec.decode(c.value,{stream:true});
        var i; while((i=buf.indexOf("\n"))!==-1){ take(buf.slice(0,i)); buf=buf.slice(i+1); }
      }
      buf+=dec.decode();
      if(buf.trim()) throw new Error("The stream ended mid-event. Hey, it's taking a little longer. Give me a few minutes.");
      if(!done) throw new Error("The stream ended before the answer was complete. Hey, it's taking a little longer. Give me a few minutes.");
      done.actions=done.actions||actions.map(function(a){return a.name;});
      return done;
    } finally { try{ await reader.cancel(); } finally { reader.releaseLock(); } }
  }
  var api={readChatStream:readChatStream,folderId:folderId};
  if(typeof module!=="undefined"&&module.exports) module.exports=api;
  else { root.readChatStream=readChatStream; root.qpChat=api; }
})(typeof window!=="undefined"?window:globalThis);
