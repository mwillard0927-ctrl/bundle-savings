/* Connects the Cattleman's page to Supabase. It provides the same small
   API the page already uses (db, user, assets, sample), so the page code
   stays the same as the Claude version. */
(function(){
  "use strict";
  var cfg = window.APP_CONFIG || {};
  var configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !/PASTE_/.test(cfg.SUPABASE_URL + cfg.SUPABASE_ANON_KEY);
  var sb = (configured && window.supabase) ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
  var sessionP = sb ? sb.auth.getSession().then(function(r){ return r.data.session; }).catch(function(){ return null; }) : Promise.resolve(null);

  function currentName(){
    return sessionP.then(function(s){
      if (!s) return "";
      var m = s.user.user_metadata || {};
      return m.name || (s.user.email || "").split("@")[0];
    });
  }

  /* ---- shared scans ---- */
  var nameCache = {}, scanListeners = [], scanTimer = null, channel = null;
  function rowToDoc(r){
    if (r.scanned_by) nameCache[r.scanned_by] = r.by_name || "";
    return {id:r.id, exists:true, data:function(){ return {
      store:r.store, item:r.item, per:Number(r.per), lbs:r.lbs == null ? 0 : Number(r.lbs),
      total:r.total == null ? null : Number(r.total), date:r.date, photoId:r.photo_id,
      by:r.scanned_by, createdAt:r.created_at }; }};
  }
  function refreshScans(){
    clearTimeout(scanTimer);
    scanTimer = setTimeout(function(){
      sb.from("scans").select("*").order("created_at", {ascending:true}).then(function(r){
        if (r.error) return;
        var snap = {docs:(r.data || []).map(rowToDoc)};
        scanListeners.forEach(function(fn){ try { fn(snap); } catch(e){} });
      });
    }, 150);
  }
  function watchScans(){
    if (channel) return;
    channel = sb.channel("scans-feed")
      .on("postgres_changes", {event:"*", schema:"public", table:"scans"}, refreshScans)
      .subscribe();
    document.addEventListener("visibilitychange", function(){ if (!document.hidden) refreshScans(); });
  }

  var db = {
    doc: function(path){
      var p = path.split("/");
      if (p[0] === "data"){            // data/users/<id>/bundle -> bundle_state row
        var uid = p[2];
        return {
          onSnapshot: function(next, err){
            var load = function(){
              sb.from("bundle_state").select("data").eq("user_id", uid).maybeSingle().then(function(r){
                if (r.error){ if (err) err(r.error); return; }
                next({exists:!!r.data, data:function(){ return r.data ? r.data.data : undefined; }});
              });
            };
            load();
            document.addEventListener("visibilitychange", function(){ if (!document.hidden) load(); });
            return function(){};
          },
          set: function(body){
            return sb.from("bundle_state").upsert({user_id:uid, data:body, updated_at:new Date().toISOString()})
              .then(function(r){ if (r.error) throw r.error; });
          }
        };
      }
      if (p[0] === "scans"){
        return { delete: function(){
          return sb.from("scans").delete().eq("id", p[1]).then(function(r){ if (r.error) throw r.error; refreshScans(); });
        }};
      }
      throw new Error("Unknown path " + path);
    },
    collection: function(name){
      return {
        onSnapshot: function(next){ scanListeners.push(next); watchScans(); refreshScans(); return function(){}; },
        add: function(x){
          return currentName().then(function(nm){
            return sb.from("scans").insert({store:x.store, item:x.item, per:x.per, lbs:x.lbs || null,
              total:x.total, date:x.date, photo_id:x.photoId || null, by_name:nm}).select("id").single();
          }).then(function(r){ if (r.error) throw r.error; refreshScans(); return {id:r.data.id}; });
        }
      };
    }
  };

  var user = {
    id: function(){ return sessionP.then(function(s){ return s ? s.user.id : null; }); },
    profiles: function(ids){
      var out = {}; [].concat(ids).forEach(function(i){ out[i] = {id:i, name:nameCache[i] || ""}; });
      return Promise.resolve(out);
    }
  };

  var assets = {
    upload: function(blob){
      return sessionP.then(function(s){
        var path = s.user.id + "/" + Date.now() + ".jpg";
        return sb.storage.from("tags").upload(path, blob, {contentType:"image/jpeg"}).then(function(r){
          if (r.error) throw r.error;
          return {id:path, url:window.photoUrl(path), sizeBytes:blob.size, contentType:"image/jpeg"};
        });
      });
    },
    delete: function(path){ return sb.storage.from("tags").remove([path]); }
  };
  window.photoUrl = function(path){ return sb && path ? sb.storage.from("tags").getPublicUrl(path).data.publicUrl : ""; };

  function blobToBase64(b){
    return new Promise(function(res, rej){
      var fr = new FileReader();
      fr.onload = function(){ res(String(fr.result).split(",")[1]); };
      fr.onerror = rej; fr.readAsDataURL(b);
    });
  }
  var sample = function(){ return Promise.reject({code:"not_supported"}); };
  sample.limits = function(){ return Promise.resolve({images:{maxCount:1}}); };
  sample.json = function(prompt, opts){
    var img = opts && opts.images && opts.images[0];
    if (!img) return Promise.reject({code:"no_image"});
    return blobToBase64(img).then(function(b64){
      return sb.functions.invoke("read-tag", {body:{image:b64, mime:img.type || "image/jpeg"}});
    }).then(function(r){
      if (r.error) throw {code:"unavailable", message:String(r.error.message || r.error)};
      if (r.data && r.data.error) throw {code:"unavailable", message:r.data.error};
      return r.data;
    });
  };

  var caps = {db:db, user:user, assets:assets, sample:sample};
  window.claude = { use: function(name){
    return sessionP.then(function(s){ return (s && caps[name]) ? caps[name] : null; });
  }};

  /* ---- sign-in bar ---- */
  function el(tag, attrs, text){ var e = document.createElement(tag); for (var k in attrs) e.setAttribute(k, attrs[k]); if (text) e.textContent = text; return e; }
  function buildAuthUI(){
    var css = el("style", {});
    css.textContent = ".authbtn{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:999px;padding:7px 14px;min-height:36px;cursor:pointer;font-family:var(--f-num);font-weight:700;font-size:14px}" +
      ".authnote{font-size:12.5px;color:var(--muted)}" +
      "#authForm input{font:inherit;font-size:16px;padding:9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);width:100%}" +
      "#authForm label{font-family:var(--f-num);font-weight:600;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}";
    document.head.appendChild(css);
    var bar = document.querySelector(".topbar");
    var btn = el("button", {"class":"authbtn", type:"button", id:"authBtn"}, "Sign in");
    bar.insertBefore(btn, bar.firstChild);

    var modal = el("div", {"class":"modal", id:"authModal", hidden:"", role:"dialog", "aria-modal":"true"});
    modal.innerHTML = '<div class="mcard"><div class="mhead"><h3>Sign in to sync</h3><button class="xbtn" id="authClose" aria-label="Close">×</button></div>' +
      '<form id="authForm" class="mgrid" style="grid-template-columns:1fr">' +
      '<div class="mfield"><label for="authName">Your name (shown on your scans)</label><input id="authName" autocomplete="name" required></div>' +
      '<div class="mfield"><label for="authEmail">Email</label><input id="authEmail" type="email" autocomplete="email" required></div>' +
      '<div class="mactions"><button class="mbtn primary" type="submit" id="authSend">Email me a sign-in link</button></div>' +
      '<div class="mstatus" id="authStatus">We\'ll email you a link. Tap it on this phone to sign in. No password needed.</div></form></div>';
    document.body.appendChild(modal);
    var close = function(){ modal.hidden = true; };
    document.getElementById("authClose").addEventListener("click", close);
    modal.addEventListener("click", function(e){ if (e.target === modal) close(); });
    try { document.getElementById("authName").value = localStorage.getItem("cbs-name") || ""; } catch(e){}

    document.getElementById("authForm").addEventListener("submit", function(e){
      e.preventDefault();
      var name = document.getElementById("authName").value.trim();
      var email = document.getElementById("authEmail").value.trim();
      var st = document.getElementById("authStatus");
      try { localStorage.setItem("cbs-name", name); } catch(err){}
      if (!sb){ st.textContent = "The app isn't connected yet: config.js still needs your Supabase values."; return; }
      document.getElementById("authSend").disabled = true;
      sb.auth.signInWithOtp({email:email, options:{emailRedirectTo:location.href.split("#")[0].split("?")[0], data:{name:name}}}).then(function(r){
        document.getElementById("authSend").disabled = false;
        st.textContent = r.error ? ("Couldn't send the link: " + r.error.message) : "Check your email and tap the link. It opens the app signed in.";
      });
    });

    sessionP.then(function(s){
      if (s){
        var m = s.user.user_metadata || {};
        var nm = m.name || (s.user.email || "").split("@")[0];
        btn.textContent = "Sign out";
        btn.title = "Signed in as " + nm;
        var saved = null; try { saved = localStorage.getItem("cbs-name"); } catch(e){}
        if (!m.name && saved) sb.auth.updateUser({data:{name:saved}});
        btn.addEventListener("click", function(){ sb.auth.signOut().then(function(){ location.reload(); }); });
        var util = document.querySelector(".util");
        if (util) util.appendChild(el("span", {"class":"authnote"}, "Signed in as " + nm));
      } else {
        btn.addEventListener("click", function(){ modal.hidden = false; });
      }
    });
    if (sb) sb.auth.onAuthStateChange(function(ev){ if (ev === "SIGNED_IN" && !window.__cbsSignedIn){ window.__cbsSignedIn = true; sessionP.then(function(s){ if (!s) location.reload(); }); } });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildAuthUI); else buildAuthUI();

  if ("serviceWorker" in navigator) window.addEventListener("load", function(){ navigator.serviceWorker.register("sw.js").catch(function(){}); });
})();
