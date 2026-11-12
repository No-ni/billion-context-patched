	ctx.inject(["storage"], (storageCtx) => {
		openLedger(storageCtx.get("storage"), (message) => ctx.logger?.warn?.(message)).then((opened) => {
			ledger = opened;
		}, (error) => {
			ctx.logger?.warn?.("model-request-accelerator: could not open the durable timing store");
			ctx.logger?.warn?.(error);
		});
	});

	// Writes still queued belong on disk before the domain closes under them.
	ctx.effect(() => () => {
		const queued = [...pendingWrites.entries()];
		pendingWrites.clear();
		const flushes = queued.map(([sessionId, timer]) => {
			clearTimeout(timer);
			if (ledger === undefined) return Promise.resolve();
			return Promise.resolve(ledger.write(sessionId, timing.snapshot(sessionId))).catch(() => {});
		});
		return Promise.all(flushes).then(() => (ledger === undefined ? undefined : ledger.close().catch(() => {})));
	});
