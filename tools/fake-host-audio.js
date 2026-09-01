/* ==========================================================================
   A test double for the Minit app's audio injection.

   This is NOT app code. It is a small reimplementation of the contract the
   app's injection presents to a game, written so the audio repair in
   index.html can be exercised on a desktop browser:

     * window.dropAudioVolume holds the volume the app wants.
     * Every AudioContext the game constructs is replaced by a subclass whose
       `destination` is a mute gain the app owns, seeded at 0. The real output
       stays reachable as _trueDestination.
     * fadeVolume(value, duration) ramps that gain.
     * A `minit.fadeDropAudioVolume` message updates the volume.
     * A context constructed while the volume is already above 0 fades itself
       in, which is how a fast-booting game picks up a value stated before it
       existed.

   Seeded with initialVolume = 0 it reproduces the two production failures:
   the app's correction never arriving (DROP-8164), and the app never stating
   a volume at all within the game's lifetime.
   ========================================================================== */
(function (initialVolume) {
	window.dropAudioVolume = initialVolume;
	window.__dropAudioContexts = [];

	const listeners = [];
	window.addEventListener('message', function (e) {
		const d = e && e.data;
		if (!d || typeof d !== 'object' || d.type !== 'minit.fadeDropAudioVolume') { return; }
		window.dropAudioVolume = d.value;
		for (const fn of listeners) { fn(d.value, d.duration || 0.3); }
	});

	const Native = window.AudioContext || window.webkitAudioContext;
	if (!Native) { return; }

	class DropAudioContext extends Native {
		constructor(...args) {
			super(...args);
			window.__dropAudioContexts.push(this);

			const gain = this.createGain();
			gain.gain.value = 0;
			gain.connect(this.destination);
			const trueDestination = this.destination;
			Object.defineProperty(this, 'destination', { get: () => gain });
			this._muteGain = gain;
			this._trueDestination = trueDestination;

			this.fadeVolume = function (value, duration) {
				this._muteGain.gain.cancelScheduledValues(this.currentTime);
				this._muteGain.gain.setValueAtTime(this._muteGain.gain.value, this.currentTime);
				this._muteGain.gain.linearRampToValueAtTime(value, this.currentTime + duration);
			};

			listeners.push((value, duration) => this.fadeVolume(value, duration));
			if (window.dropAudioVolume > 0) {
				setTimeout(() => this.fadeVolume(window.dropAudioVolume, 0.3), 50);
			}
		}
	}

	window.AudioContext = DropAudioContext;
	window.webkitAudioContext = DropAudioContext;
}(Number(window.__fakeHostInitialVolume ?? 0)));
