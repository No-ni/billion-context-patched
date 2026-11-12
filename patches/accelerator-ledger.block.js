	// bili-context-patch: scoped-ledger-start
	// The optional scope owns BOTH the asynchronous open and its returned handle.
	// Cordis awaits setup before disposal; storageDomain also orders teardown ahead
	// of the domain facility, and lets a domain service arriving later activate it.
	ctx.inject(["storage", "storageDomain"], async (storageCtx) => {
		let opened;
		try {
			opened = await openLedger(storageCtx.get("storage"), (message) => ctx.logger?.warn?.(message));
		} catch (error) {
			ctx.logger?.warn?.("model-request-accelerator: could not open the durable timing store");
			ctx.logger?.warn?.(error);
		}
		if (opened === undefined) return;
		ledger = opened;
		consulted.clear();
		return async () => {
			if (ledger === opened) ledger = undefined;
			const queued = [...pendingWrites.entries()];
			pendingWrites.clear();
			const flushes = queued.map(([sessionId, timer]) => {
				clearTimeout(timer);
				return Promise.resolve().then(() => opened.write(sessionId, timing.snapshot(sessionId))).catch(() => {});
			});
			await Promise.all(flushes);
			// Keep the owned handle even when a read error cleared the live ledger.
			await opened.close().catch(() => {});
		};
	});
	// bili-context-patch: scoped-ledger-end
