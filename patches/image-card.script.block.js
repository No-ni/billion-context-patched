    // <bili-image-card:js begin>
    // Four top-level keys of this same config file decide whether a picture
    // leaves once or on every turn (the retention pass in the proxy reads
    // them). The card edits the draft the raw editor already holds, so one
    // Save writes one file and the keys stay visible there like any other.
    function hydrateImageCard(cfg) {
        const box = $("image-fields");
        if (!box) return;
        box.innerHTML = "";
        const fe = $("cfg-file-edit");
        const MIN_DIM = 128, DEFAULT_DIM = 1200;
        let draft = {};
        try {
            const p = parseConfigDraft(fe && fe.value ? fe.value : "{}");
            draft = p && typeof p === "object" && !Array.isArray(p) ? p : {};
        } catch (e) { return; }
        const brokenNote = document.createElement("div");
        brokenNote.style.cssText = "min-height:16px;font-size:12px;color:#cf222e";
        box.appendChild(brokenNote);
        const iCtrls = [];
        function broken(on) {
            brokenNote.textContent = on ? t("cfg.q_parse_err") : "";
            iCtrls.forEach((el) => { el.disabled = !!on; });
        }
        function commit(mutate) {
            let fresh = null;
            try {
                const p = parseConfigDraft(fe && fe.value ? fe.value : "{}");
                if (p && typeof p === "object" && !Array.isArray(p)) fresh = p;
            } catch (e) { fresh = null; }
            if (!fresh) { broken(true); return; }
            mutate(fresh);
            if (fe) fe.value = JSON.stringify(fresh, null, 2);
            draft = fresh;
            broken(false);
            refreshDirtyFlag();
        }
        function flagRow(id, labelKey, hintKey) {
            const w = document.createElement("div");
            w.style.cssText = "display:flex;gap:12px;align-items:center;flex-wrap:wrap";
            const lab = document.createElement("label");
            lab.style.cssText = "flex:0 1 auto;max-width:520px";
            const inp = document.createElement("input");
            inp.type = "checkbox";
            inp.id = id;
            lab.appendChild(inp);
            lab.append(document.createTextNode(" \u2009" + t(labelKey)));
            const ctl = document.createElement("div");
            ctl.style.flex = "0 0 auto";
            const hint = document.createElement("span");
            hint.className = "dim small";
            hint.textContent = t(hintKey);
            ctl.appendChild(hint);
            w.appendChild(lab);
            w.appendChild(ctl);
            box.appendChild(w);
            iCtrls.push(inp);
            return inp;
        }
        function dimValue(d) {
            return Number.isInteger(d.imageRetentionMaxDim) && d.imageRetentionMaxDim >= MIN_DIM ? d.imageRetentionMaxDim : DEFAULT_DIM;
        }
        const retention = flagRow("image-retention", "cfg.image_retention", "cfg.image_retention_hint");
        retention.addEventListener("change", () => commit((d) => { if (retention.checked) delete d.imageRetention; else d.imageRetention = false; }));
        const keepLast = flagRow("image-keep-last", "cfg.image_keep_last", "cfg.image_keep_last_hint");
        keepLast.addEventListener("change", () => commit((d) => { if (keepLast.checked) delete d.imageRetentionKeepLastUser; else d.imageRetentionKeepLastUser = false; }));
        const dimWrap = document.createElement("div");
        dimWrap.style.cssText = "display:flex;gap:12px;align-items:center;flex-wrap:wrap";
        const dimLab = document.createElement("label");
        dimLab.htmlFor = "image-max-dim";
        dimLab.style.cssText = "flex:0 1 auto;max-width:520px";
        dimLab.textContent = t("cfg.image_max_dim");
        const dimInp = document.createElement("input");
        dimInp.type = "number";
        dimInp.id = "image-max-dim";
        dimInp.className = "field-input mono";
        dimInp.min = String(MIN_DIM);
        dimInp.step = "1";
        dimInp.style.flex = "0 0 120px";
        const dimHint = document.createElement("span");
        dimHint.className = "dim small";
        dimHint.textContent = t("cfg.image_max_dim_hint");
        dimWrap.appendChild(dimLab);
        dimWrap.appendChild(dimInp);
        dimWrap.appendChild(dimHint);
        box.appendChild(dimWrap);
        iCtrls.push(dimInp);
        dimInp.addEventListener("change", () => {
            const raw = String(dimInp.value || "").trim();
            const value = Number(raw);
            if (!/^[0-9]+$/.test(raw) || !Number.isInteger(value) || value < MIN_DIM) {
                brokenNote.textContent = t("cfg.image_dim_invalid");
                dimInp.value = String(dimValue(draft));
                return;
            }
            commit((d) => { d.imageRetentionMaxDim = value; });
        });
        const promptRow = flagRow("image-prompt", "cfg.image_prompt", "cfg.image_prompt_hint");
        promptRow.addEventListener("change", () => commit((d) => { if (promptRow.checked) delete d.imagePrompt; else d.imagePrompt = false; }));
        retention.checked = draft.imageRetention !== false;
        keepLast.checked = draft.imageRetentionKeepLastUser !== false;
        promptRow.checked = draft.imagePrompt !== false;
        dimInp.value = String(dimValue(draft));
        if (cfg && cfg.parseError) iCtrls.forEach((el) => { el.disabled = true; });
    }
    // <bili-image-card:js end>
