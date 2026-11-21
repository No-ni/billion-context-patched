    // <bili-image-card:js begin>
    // The card and the raw editor share a single config draft and Save.
    function hydrateImageCard(cfg) {
        const box = $("image-fields");
        if (!box) return;
        box.innerHTML = "";
        const fe = $("cfg-file-edit");
        const DEFAULT_REQUEST_KB = 150, DEFAULT_TOTAL_KB = 2048, DEFAULT_PIXELS = 1440000;
        const DEFAULT_IMAGES = 20, DEFAULT_QUANTUM = 10;
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
                    brokenNote.textContent = t("cfg.image_budget_invalid");
                    input.value = String(value);
                } else {
                    value = n;
                }
            });
            return input;
        }
        const number = (value, min, fallback) => Number.isSafeInteger(value) && value >= min ? value : fallback;
        const kib = (value, fallback) => Number.isSafeInteger(value) && value >= 1024
            ? Math.max(1, Math.round(value / 1024)) : fallback;
        let requestKb = kib(draft.requestImageMaxBytes, DEFAULT_REQUEST_KB);
        let totalKb = kib(draft.maxRequestImageBytes, DEFAULT_TOTAL_KB);
        function requestBudget(n) {
            if (n > totalKb) return false;
            commit(d => { d.requestImageMaxBytes = n * 1024; });
            requestKb = n;
            return true;
        }
        function totalBudget(n) {
            if (n < requestKb) return false;
            commit(d => { d.maxRequestImageBytes = n * 1024; });
            totalKb = n;
            return true;
        }
        numberRow("image-request-kb", "cfg.image_request_kb", 1, requestKb, requestBudget);
        numberRow("image-total-kb", "cfg.image_total_kb", 1, totalKb, totalBudget);
        numberRow("image-pixel-budget", "cfg.image_pixel_budget", 1,
            number(draft.requestImagePixelBudget, 1, DEFAULT_PIXELS), n => {
                commit(d => { d.requestImagePixelBudget = n; });
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
        if (cfg && cfg.parseError) iCtrls.forEach((el) => { el.disabled = true; });
    }
    // <bili-image-card:js end>
