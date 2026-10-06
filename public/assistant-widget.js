/* Queer Pathways website assistant — self-contained widget.
   NOT CLEARED FOR PUBLICATION. Load this only after compliance clearance and after the route is live.
   No cookies, no storage, no identifiers. History lives in memory for the tab and dies with it. */
(function () {
  "use strict";

  var ENDPOINT = "/api/assistant";
  var BOOKING = "https://www.therapyportal.com/p/queercharts/";
  var OPENER = "Hello — I can help with questions about the practice, or point you to booking. What would you like to know?";
  var history = [];

  var css = document.createElement("style");
  css.textContent = [
    "#qp-assist-btn{position:fixed;right:20px;bottom:20px;z-index:9998;background:#153009;color:#CBB26A;",
    "border:1px solid #CBB26A;border-radius:999px;padding:12px 20px;font:500 15px/1 Arial,sans-serif;cursor:pointer}",
    "#qp-assist-btn:focus-visible{outline:2px solid #D3B127;outline-offset:2px}",
    "#qp-assist{position:fixed;right:20px;bottom:76px;z-index:9999;width:min(380px,calc(100vw - 40px));",
    "max-height:min(560px,calc(100vh - 120px));display:none;flex-direction:column;background:#020501;",
    "border:1px solid #153009;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.55);overflow:hidden}",
    "#qp-assist.open{display:flex}",
    "#qp-assist header{padding:14px 16px;border-bottom:1px solid #153009;background:#153009;color:#CBB26A;",
    "font:600 15px/1.3 Arial,sans-serif}",
    "#qp-assist header small{display:block;font-weight:400;font-size:12px;color:#8f9a86;margin-top:4px}",
    "#qp-assist .log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}",
    "#qp-assist .m{max-width:88%;padding:10px 12px;border-radius:10px;font:400 14px/1.5 Arial,sans-serif;",
    "white-space:pre-wrap;word-wrap:break-word}",
    "#qp-assist .m.bot{background:#0b1405;color:#e6e2d8;align-self:flex-start;border:1px solid #153009}",
    "#qp-assist .m.me{background:#1d1d1d;color:#e6e2d8;align-self:flex-end}",
    "#qp-assist .m.err{background:#2a1414;color:#e8c8c8;align-self:flex-start;border:1px solid #4a2020}",
    "#qp-assist form{display:flex;gap:8px;padding:12px;border-top:1px solid #153009}",
    "#qp-assist input{flex:1;background:#0b1405;border:1px solid #153009;color:#e6e2d8;border-radius:8px;",
    "padding:10px 12px;font:400 14px/1.4 Arial,sans-serif}",
    "#qp-assist input:focus{outline:2px solid #D3B127;outline-offset:1px}",
    "#qp-assist button.send{background:#D3B127;color:#020501;border:0;border-radius:8px;padding:0 16px;",
    "font:600 14px/1 Arial,sans-serif;cursor:pointer}",
    "#qp-assist button.send[disabled]{opacity:.5;cursor:default}",
    "#qp-assist .note{padding:0 16px 12px;font:400 11px/1.4 Arial,sans-serif;color:#8f9a86}",
    "#qp-assist .note a{color:#CBB26A}"
  ].join("");
  document.head.appendChild(css);

  var btn = document.createElement("button");
  btn.id = "qp-assist-btn";
  btn.type = "button";
  btn.setAttribute("aria-expanded", "false");
  btn.textContent = "Questions?";

  var panel = document.createElement("div");
  panel.id = "qp-assist";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Website assistant");
  panel.innerHTML =
    '<header>Queer Pathways<small>Automated assistant — not a clinician, and not part of any clinical record.</small></header>' +
    '<div class="log" id="qp-assist-log"></div>' +
    '<form id="qp-assist-form"><input id="qp-assist-input" type="text" autocomplete="off" ' +
    'placeholder="Ask about intake, rates, or booking" aria-label="Your question"><button class="send" type="submit">Send</button></form>' +
    '<div class="note">Cannot help? <a href="' + BOOKING + '" target="_blank" rel="noopener">Book an intake assessment</a>. ' +
    'In a crisis, call or text 988.</div>';

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var log = panel.querySelector("#qp-assist-log");
  var form = panel.querySelector("#qp-assist-form");
  var input = panel.querySelector("#qp-assist-input");
  var send = panel.querySelector("button.send");

  function add(text, cls) {
    var el = document.createElement("div");
    el.className = "m " + cls;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  btn.addEventListener("click", function () {
    var open = panel.classList.toggle("open");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      if (!log.children.length) add(OPENER, "bot");
      input.focus();
    }
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    add(text, "me");
    send.disabled = true;

    var pending = add("…", "bot");

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // History is sent for context and never stored anywhere.
      body: JSON.stringify({ message: text, history: history })
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) {
        if (d && d.reply) {
          pending.textContent = d.reply;
          history.push({ role: "user", text: text });
          history.push({ role: "model", text: d.reply });
          if (history.length > 12) history = history.slice(-12);
        } else {
          pending.className = "m err";
          pending.textContent = "I could not answer just then. You can book an intake assessment and a person will pick it up.";
        }
      })
      .catch(function () {
        pending.className = "m err";
        pending.textContent = "I could not answer just then. You can book an intake assessment and a person will pick it up.";
      })
      .then(function () { send.disabled = false; });
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && panel.classList.contains("open")) {
      panel.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
      btn.focus();
    }
  });
})();
