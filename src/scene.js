/* ==========================================================================
   The scene: a ball on a grass plane, lit by one directional light.

   Everything is built in code rather than loaded from assets. That keeps the
   bundle to the engine plus a few hundred bytes, and it means the template has
   no binary pipeline to explain -- which is the point of a starter.

   Nothing in here knows about the SDK or scoring. It reports what happened
   through the callbacks given to create(), and main.js decides what that is
   worth.
   ========================================================================== */
import {
	AppBase, AppOptions, createGraphicsDevice, Entity, Color, Vec3, StandardMaterial,
	RenderComponentSystem, CameraComponentSystem, LightComponentSystem,
	FILLMODE_FILL_WINDOW, RESOLUTION_AUTO, SHADOW_PCF3,
} from 'playcanvas';

const GRAVITY = 26;            // world units/s^2
const RESTITUTION = 0.62;
const TAP_IMPULSE = 11.5;
const REST_SPEED = 0.4;
const BALL_RADIUS = 0.62;
const REST_Y = BALL_RADIUS * 0.85;   // nestled into the grass rather than sitting on it

function material(rgb, { shininess = 0, metalness = 0 } = {}) {
	const m = new StandardMaterial();
	m.diffuse = new Color(...rgb);
	m.gloss = shininess;
	m.metalness = metalness;
	m.useMetalness = metalness > 0;
	m.update();
	return m;
}

export async function createScene(canvas, { onTap, onBounce }) {
	// The modular AppBase/AppOptions init rather than the all-in-one
	// `new Application(...)` the docs show. Application registers every
	// component system and resource handler that exists, none of which Rollup
	// can then drop: it builds to 2.3 MB. Declaring the three systems this
	// scene actually uses -- and no resource handlers, since every mesh and
	// material here is made in code -- builds the same game far smaller.
	const device = await createGraphicsDevice(canvas, {
		deviceTypes: ['webgl2'],
		antialias: true,
		alpha: false,
	});

	const options = new AppOptions();
	options.graphicsDevice = device;
	options.componentSystems = [RenderComponentSystem, CameraComponentSystem, LightComponentSystem];
	options.resourceHandlers = [];

	const app = new AppBase(canvas);
	app.init(options);

	// The game fills a portrait slot whose shape the host decides, so the
	// canvas follows the window rather than a fixed design size.
	app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
	app.setCanvasResolution(RESOLUTION_AUTO);

	app.scene.ambientLight = new Color(0.46, 0.52, 0.6);

	const camera = new Entity('camera');
	camera.addComponent('camera', {
		clearColor: new Color(0.29, 0.62, 0.84),
		fov: 46,
		nearClip: 0.1,
		farClip: 600,
	});
	// Where the horizon lands is set by the camera's pitch, not by any
	// fraction of the screen: pitching DOWN raises it, pitching UP lowers it.
	// Measured, this puts it a little past 60% of the way down, leaving open
	// grass beneath the ball for the end-game button.
	camera.setPosition(0, 1.15, 7.5);
	camera.setEulerAngles(5, 0, 0);
	app.root.addChild(camera);

	const light = new Entity('light');
	light.addComponent('light', {
		// A STRING, not the LIGHTTYPE_DIRECTIONAL constant. The component takes
		// 'directional' | 'omni' | 'spot' and stores it as light._type; handing
		// it the numeric enum instead leaves _type invalid, and the renderer
		// then throws every frame inside its own light gathering:
		//
		//   splitLights[light._type].push(light)
		//   -> TypeError: Cannot read properties of undefined (reading 'push')
		//
		// which kills the whole lighting pass. The scene still draws, lit by
		// ambient alone, so it looks like a lighting setup that needs tuning
		// rather than an exception -- and no amount of moving the light or
		// raising its intensity changes anything, because a second, correct
		// light is poisoned by the first one just the same.
		type: 'directional',
		color: new Color(1, 0.97, 0.88),
		intensity: 2.1,
		castShadows: true,
		shadowType: SHADOW_PCF3,
		shadowBias: 0.02,
		normalOffsetBias: 0.02,
		shadowResolution: 1024,
		shadowDistance: 30,
	});
	// A directional light shines along its local -Z, so a POSITIVE x-euler
	// tilts that vector upward. (52, 28, 0) gave forward = [-0.29, +0.79,
	// -0.54] -- aimed at the sky, lighting nothing, leaving the scene on
	// ambient alone and looking flat and unlit. Negative pitch points it down.
	// Raked shallow rather than dropped straight down. A steep light gives the
	// ground (normals pointing up) almost all of it and the ball's
	// camera-facing side almost none, which reads as a bright field with a
	// dark blob sitting on it. Coming in low over the camera's shoulder lights
	// the face the player is actually looking at, and throws a long shadow
	// that sells the ball's height above the grass.
	light.setEulerAngles(-34, 22, 0);
	app.root.addChild(light);

	const ground = new Entity('ground');
	ground.addComponent('render', { type: 'plane', material: material([0.29, 0.62, 0.22]) });
	// Big enough that its far edge is past the far clip, so the player sees a
	// horizon rather than the end of a plane.
	ground.setLocalScale(1200, 1, 1200);
	app.root.addChild(ground);

	const ball = new Entity('ball');
	ball.addComponent('render', {
		type: 'sphere',
		material: material([0.92, 0.21, 0.24], { shininess: 55 }),
		castShadows: true,
	});
	ball.setLocalScale(BALL_RADIUS * 2, BALL_RADIUS * 2, BALL_RADIUS * 2);
	ball.setPosition(0, REST_Y, 0);
	app.root.addChild(ball);

	const cloudMaterial = material([1, 1, 1]);
	cloudMaterial.emissive = new Color(0.55, 0.6, 0.68);
	cloudMaterial.update();
	const clouds = [];
	for (let i = 0; i < 6; i++) {
		const cloud = new Entity(`cloud${i}`);
		cloud.addComponent('render', { type: 'sphere', material: cloudMaterial, castShadows: false });
		const s = 3 + Math.random() * 4;
		cloud.setLocalScale(s * 2.4, s * 0.9, s);
		cloud.setPosition(-60 + Math.random() * 120, 16 + Math.random() * 12, -80 - Math.random() * 60);
		app.root.addChild(cloud);
		clouds.push({ entity: cloud, speed: 0.4 + Math.random() * 0.8 });
	}

	/* ---- simulation ---------------------------------------------------- */
	const velocity = new Vec3(0, 0, 0);
	let spin = 0;
	let started = false;

	function step(dt) {
		const p = ball.getPosition();
		let { x, y } = p;

		velocity.y -= GRAVITY * dt;
		x += velocity.x * dt;
		y += velocity.y * dt;
		velocity.x -= velocity.x * 0.4 * dt;

		// Side walls, derived from the camera rather than picked as a world
		// distance. A fixed number cannot work here: how much of the world is
		// visible across the screen depends on the field of view, on how far
		// the ball is from the camera, and on the aspect ratio of a slot whose
		// shape the host decides. In a 2:3 portrait slot the visible half-width
		// at the ball is about 2.1 units, so a hardcoded 4.2 put the wall at
		// roughly twice the screen edge and the ball simply left the view.
		const limit = sideLimit(y);
		if (x < -limit) { x = -limit; velocity.x = Math.abs(velocity.x) * 0.6; }
		if (x > limit) { x = limit; velocity.x = -Math.abs(velocity.x) * 0.6; }

		const ceiling = ceilingY(y);
		if (y > ceiling) {
			y = ceiling;
			velocity.y = -Math.abs(velocity.y) * 0.5;
		}

		if (y <= REST_Y) {
			y = REST_Y;
			if (-velocity.y > REST_SPEED) {
				const impact = -velocity.y;
				velocity.y = impact * RESTITUTION;
				velocity.x *= 0.86;
				onBounce(impact / 12);
			} else {
				velocity.y = 0;
				velocity.x *= 0.9;
			}
		}

		spin += velocity.x * dt * 1.6;
		ball.setPosition(x, y, 0);
		ball.setEulerAngles(0, 0, -spin * 57.3);

		for (const c of clouds) {
			const cp = c.entity.getPosition();
			let cx = cp.x + c.speed * dt;
			if (cx > 70) { cx = -70; }
			c.entity.setPosition(cx, cp.y, cp.z);
		}
	}

	/**
	 * Half-width of the visible world, in world units, at the ball's depth --
	 * minus the ball's own radius, so the whole ball stays on screen rather
	 * than its centre.
	 *
	 * fov is vertical by default (camera.horizontalFov is false), so the
	 * horizontal extent is the vertical one times the aspect ratio. On a
	 * portrait slot the aspect is below 1, which makes the horizontal extent
	 * the tighter of the two -- exactly the constraint being missed.
	 */
	/** Distance along the view axis to the plane the ball moves in. */
	function depthAt(ballY) {
		const camPos = camera.getPosition();
		const fwd = camera.forward;
		return Math.max((0 - camPos.x) * fwd.x + (ballY - camPos.y) * fwd.y + (0 - camPos.z) * fwd.z, 0.1);
	}

	function sideLimit(ballY) {
		const cam = camera.camera;
		const depth = depthAt(ballY);
		const halfHeight = Math.tan((cam.fov * Math.PI) / 360) * depth;
		const halfWidth = halfHeight * (cam.aspectRatio || 1);
		// A little more than the radius. Under perspective a sphere's silhouette
		// is wider than the projection of its centre-plane radius, so clearing
		// exactly BALL_RADIUS still shaves the edge -- and a ball that stops
		// flush against the screen border reads as clipping rather than as
		// bouncing off something. The margin buys both.
		// Never collapse to nothing on a pathologically narrow viewport.
		return Math.max(halfWidth - BALL_RADIUS * 1.18, BALL_RADIUS * 0.5);
	}

	/**
	 * Highest world y the ball may reach and still be fully visible.
	 *
	 * Same reasoning as sideLimit, and the same trap: the top of the view is
	 * not a number anyone can write down. At the ball's depth it sits at the
	 * camera's height, plus how far the pitched view axis has climbed over
	 * that distance, plus the vertical half-extent -- roughly y = 5 in this
	 * scene, against the 13.5 a hardcoded guess had allowed. A tap capped
	 * against that guess launched the ball clean out of the top of the screen,
	 * where it cannot be hit and the rally dies waiting for it to fall back.
	 */
	function ceilingY(ballY) {
		const cam = camera.camera;
		const camPos = camera.getPosition();
		const fwd = camera.forward;
		const up = camera.up;
		const depth = depthAt(ballY);
		const halfHeight = Math.tan((cam.fov * Math.PI) / 360) * depth;
		return camPos.y + fwd.y * depth + up.y * halfHeight - BALL_RADIUS * 1.18;
	}

	/* ---- screen-space helpers -------------------------------------------
	   The HUD, the hit test and the button all live in CSS pixels, so the few
	   world positions they care about are projected here rather than each
	   caller reaching into the camera. */
	const tmp = new Vec3();

	function ballScreen() {
		const s = camera.camera.worldToScreen(ball.getPosition(), tmp);
		return { x: s.x, y: s.y };
	}

	/** Projected radius in CSS pixels, so the hit area tracks perspective. */
	function ballScreenRadius() {
		const p = ball.getPosition();
		const centre = camera.camera.worldToScreen(p, new Vec3());
		const edge = camera.camera.worldToScreen(new Vec3(p.x, p.y + BALL_RADIUS, p.z), new Vec3());
		return Math.abs(centre.y - edge.y);
	}

	/** Where the ball sits at rest, in screen space -- the button clears this. */
	function restScreen() {
		const s = camera.camera.worldToScreen(new Vec3(0, REST_Y, 0), new Vec3());
		const edge = camera.camera.worldToScreen(new Vec3(0, REST_Y + BALL_RADIUS, 0), new Vec3());
		return { y: s.y, radius: Math.abs(s.y - edge.y) };
	}

	/** Screen y where the ground meets the sky. */
	function horizonY() {
		// A point far enough down the ground plane that it is visually at the
		// horizon; the camera's own projection decides where that lands, which
		// is the only honest answer once the viewport shape can change.
		const far = camera.camera.worldToScreen(new Vec3(0, 0, -500), new Vec3());
		return far.y;
	}

	function tryHit(x, y) {
		const s = ballScreen();
		// A fingertip is about 44 px, and the ball is a moving target, so the
		// hit area is deliberately larger than the ball looks.
		const reach = Math.max(ballScreenRadius() * 1.5, 30);
		const dx = x - s.x, dy = y - s.y;
		if (dx * dx + dy * dy > reach * reach) { return false; }

		started = true;
		// A tap SETS upward velocity rather than adding to it, so each hit
		// lifts the ball the same distance from wherever it is -- a rally
		// climbs. Capping by the headroom left keeps it from leaving the top of
		// the view, where it cannot be tapped and the rally dies waiting for it
		// to fall back.
		const headroom = Math.max(0, ceilingY(ball.getPosition().y) - ball.getPosition().y);
		velocity.y = Math.min(TAP_IMPULSE, Math.sqrt(2 * GRAVITY * headroom));
		velocity.x += (dx / reach) * 3.2;
		onTap();
		return true;
	}

	return {
		app, camera, ball,
		step, tryHit, ballScreen, ballScreenRadius, horizonY, restScreen,
		get started() { return started; },
	};
}
