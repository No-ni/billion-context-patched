    // <bili-image-card:js begin>
    // The card and the raw editor share a single config draft and Save.
    function hydrateImageCard(cfg) {
        const box = $("image-fields");
        if (!box) return;
        box.innerHTML = "";
        const fe = $("cfg-file-edit");
        const MIN_DIM = 128, DEFAULT_DIM = 1200, DEFAULT_IMAGES = 20, DEFAULT_QUANTUM = 10;
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
        function numberRow(id, key, min, value, onChange) {
            const w = document.createElement("div");
            w.style.cssText = "display:flex;gap:12px;align-items:center;flex-wrap:wrap";
            const label = document.createElement("label");
            label.htmlFor = id;
            label.textContent = t(key);
            const input = document.createElement("input");
            input.type = "number";
            input.id = id;
            input.className = "field-input mono";
            input.min = String(min);
            input.step = "1";
            input.style.flex = "0 1 120px;min-width:0";
            input.value = String(value);
            const hint = document.createElement("span");
            hint.className = "dim small";
            hint.textContent = t(key + "_hint");
            input.setAttribute("aria-describedby", id + "-hint");
            hint.id = id + "-hint";
            w.appendChild(label);
            w.appendChild(input);
            w.appendChild(hint);
            box.appendChild(w);
            iCtrls.push(input);
            input.addEventListener("change", () => {
                const raw = String(input.value).trim();
                const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
                if (!Number.isSafeInteger(n) || n < min || !onChange(n)) {
                    brokenNote.textContent = t(min === MIN_DIM ? "cfg.image_dim_invalid" : "cfg.image_budget_invalid");
                    input.value = String(value);
                } else {
                    value = n;
                }
            });
            return input;
        }
        const retention = flagRow("image-retention", "cfg.image_retention", "cfg.image_retention_hint");
        retention.addEventListener("change", () => commit((d) => { if (retention.checked) delete d.imageRetention; else d.imageRetention = false; }));
        const keepLast = flagRow("image-keep-last", "cfg.image_keep_last", "cfg.image_keep_last_hint");
        keepLast.addEventListener("change", () => commit((d) => { if (keepLast.checked) delete d.imageRetentionKeepLastUser; else d.imageRetentionKeepLastUser = false; }));
        const number = (value, min, fallback) => Number.isSafeInteger(value) && value >= min ? value : fallback;
        numberRow("image-max-dim", "cfg.image_max_dim", MIN_DIM,
            number(draft.imageRetentionMaxDim, MIN_DIM, DEFAULT_DIM), (n) => {
                commit(d => { d.imageRetentionMaxDim = n; });
                return true;
            });
        let max = number(draft.maxRequestImages, 1, DEFAULT_IMAGES);
        let batch = Math.min(max, number(draft.imageOffloadCountQuantum, 1, DEFAULT_QUANTUM));
        function budget(n, count) {
            if (count > n) return false;
            commit(d => { d.maxRequestImages = n; d.imageOffloadCountQuantum = count; });
            max = n;
            batch = count;
            batchInput.max = String(n);
            return true;
        }
        numberRow("image-max-request", "cfg.image_max_request", 1, max, n => budget(n, batch));
        const batchInput = numberRow("image-offload-quantum", "cfg.image_offload_quantum", 1, batch, n => {
            return budget(max, n);
        });
        batchInput.max = String(max);
        const promptRow = flagRow("image-prompt", "cfg.image_prompt", "cfg.image_prompt_hint");
        promptRow.addEventListener("change", () => commit((d) => { if (promptRow.checked) delete d.imagePrompt; else d.imagePrompt = false; }));
        retention.checked = draft.imageRetention !== false;
        keepLast.checked = draft.imageRetentionKeepLastUser !== false;
        promptRow.checked = draft.imagePrompt !== false;
        if (cfg && cfg.parseError) iCtrls.forEach((el) => { el.disabled = true; });
    }
    // <bili-image-card:js end>
