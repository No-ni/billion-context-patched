        // <bili-image-card:listeners begin>
        // The card edits four top-level keys of the same draft; its Save is the
        // quick card's Save (one whole-file PUT, validated server-side).
        const si = $("save-image");
        if (si) si.addEventListener("click", async () => {
            const el = $("cfg-file-edit");
            const raw = el ? el.value : "";
            let parsed;
            try { parsed = parseConfigDraft(raw || "{}"); } catch (e) {
                toast(t("cfg.invalid_json"), "err");
                return;
            }
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                toast(t("cfg.invalid_json"), "err");
                return;
            }
            await putCfg(si, { file: raw });
        });
        const ri = $("reset-image");
        if (ri) ri.addEventListener("click", () => {
            const el = $("cfg-file-edit");
            let draft;
            try { draft = parseConfigDraft(el && el.value ? el.value : "{}"); } catch (e) {
                toast(t("cfg.invalid_json"), "err");
                return;
            }
            if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
                toast(t("cfg.invalid_json"), "err");
                return;
            }
            delete draft.imageRetention;
            delete draft.imageRetentionKeepLastUser;
            delete draft.imageRetentionMaxDim;
            delete draft.imagePrompt;
            if (el) el.value = JSON.stringify(draft, null, 2);
            refreshDirtyFlag();
            hydrateImageCard();
            toast(t("cfg.image_restored"), "ok");
        });
        // <bili-image-card:listeners end>
