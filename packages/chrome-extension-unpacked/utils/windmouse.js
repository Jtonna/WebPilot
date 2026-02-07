/**
 * WindMouse algorithm for generating human-like mouse movement paths.
 *
 * Based on the classic algorithm used in game automation, adapted for
 * browser automation with realistic acceleration curves and distance-based
 * Hz caps that mimic real human mouse movement.
 */

/**
 * Get the Hz cap and generate a random peak Hz based on distance.
 *
 * @param {number} distance - Total distance in pixels
 * @returns {{maxHz: number, peakHz: number}}
 */
function getHzCapForDistance(distance) {
  let maxHz;

  if (distance < 300) {
    maxHz = 250;
  } else if (distance < 800) {
    maxHz = 500;
  } else if (distance >= 1200) {
    maxHz = 1000;
  } else {
    // 800-1200px: interpolate between 500 and 1000
    const ratio = (distance - 800) / 400;
    maxHz = Math.floor(500 + ratio * 500);
  }

  // Random peak Hz between 70-100% of max
  const peakHz = Math.floor(maxHz * (0.7 + Math.random() * 0.3));

  return { maxHz, peakHz };
}

/**
 * Calculate speed multiplier based on progress along path.
 * Creates acceleration curve: slow start → peak at 50-80% → slow end
 *
 * @param {number} progress - 0 to 1, position along path
 * @param {number} peakStart - When peak speed starts (0.5)
 * @param {number} peakEnd - When peak speed ends (0.8)
 * @returns {number} Speed multiplier 0-1
 */
function getSpeedCurve(progress, peakStart = 0.5, peakEnd = 0.8) {
  if (progress < peakStart) {
    // Acceleration phase: ease-in (quadratic)
    const t = progress / peakStart;
    return t * t;
  } else if (progress <= peakEnd) {
    // Peak speed phase
    return 1;
  } else {
    // Deceleration phase: ease-out (quadratic)
    const t = (progress - peakEnd) / (1 - peakEnd);
    return 1 - (t * t);
  }
}

/**
 * Generate a human-like mouse path from start to end point.
 *
 * @param {number} startX - Starting X coordinate
 * @param {number} startY - Starting Y coordinate
 * @param {number} endX - Target X coordinate
 * @param {number} endY - Target Y coordinate
 * @param {Object} options - Algorithm tuning parameters
 * @returns {Array<{x: number, y: number, dt: number}>} Path points with timing
 */
export function generateWindMousePath(startX, startY, endX, endY, options = {}) {
  const {
    gravity = 9,           // Pull toward target (higher = more direct path)
    wind = 3,              // Random deviation strength (higher = more wobbly)
    maxStep = 15,          // Maximum pixels per step
    targetRadius = 2,      // Arrival threshold in pixels
  } = options;

  // Calculate total distance for Hz cap
  const totalDistance = Math.hypot(endX - startX, endY - startY);

  // Handle very short distances
  if (totalDistance < 5) {
    return [{ x: Math.round(endX), y: Math.round(endY), dt: 10 }];
  }

  // Get Hz caps based on distance
  const { peakHz } = getHzCapForDistance(totalDistance);

  // Minimum Hz (at start/end of movement)
  const minHz = Math.max(50, peakHz * 0.15); // 15% of peak, minimum 50Hz

  // Randomize peak position between 50-80%
  const peakStart = 0.4 + Math.random() * 0.15; // 40-55%
  const peakEnd = 0.7 + Math.random() * 0.15;   // 70-85%

  // First pass: generate path points using WindMouse
  const rawPoints = [];
  let x = startX;
  let y = startY;

  let windX = 0;
  let windY = 0;
  let velocityX = 0;
  let velocityY = 0;

  const sqrt2 = Math.sqrt(2);
  const sqrt3 = Math.sqrt(3);
  const sqrt5 = Math.sqrt(5);

  while (true) {
    const dx = endX - x;
    const dy = endY - y;
    const distance = Math.hypot(dx, dy);

    if (distance <= targetRadius) {
      rawPoints.push({ x: Math.round(endX), y: Math.round(endY) });
      break;
    }

    // Update wind
    const windMag = Math.min(wind, distance);
    if (distance >= targetRadius) {
      windX = windX / sqrt3 + (Math.random() * 2 - 1) * windMag / sqrt5;
      windY = windY / sqrt3 + (Math.random() * 2 - 1) * windMag / sqrt5;
    } else {
      windX /= sqrt2;
      windY /= sqrt2;
    }

    // Gravity pull
    const gravityMag = Math.min(gravity, distance);
    const gravityX = (gravityMag * dx) / distance;
    const gravityY = (gravityMag * dy) / distance;

    // Update velocity
    velocityX += windX + gravityX;
    velocityY += windY + gravityY;

    // Limit speed
    const speed = Math.hypot(velocityX, velocityY);
    const maxSpeed = Math.min(maxStep, distance / 2 + 1);

    if (speed > maxSpeed) {
      const scale = maxSpeed / speed;
      velocityX *= scale;
      velocityY *= scale;
    }

    x += velocityX;
    y += velocityY;

    rawPoints.push({ x: Math.round(x), y: Math.round(y) });

    if (rawPoints.length > 10000) {
      console.warn('WindMouse: Path exceeded 10000 points, forcing termination');
      rawPoints.push({ x: Math.round(endX), y: Math.round(endY) });
      break;
    }
  }

  // Second pass: calculate dt values based on acceleration curve
  const path = [];
  const totalPoints = rawPoints.length;

  for (let i = 0; i < totalPoints; i++) {
    const progress = i / (totalPoints - 1 || 1);

    // Get speed multiplier from acceleration curve
    const speedMult = getSpeedCurve(progress, peakStart, peakEnd);

    // Calculate Hz at this point: interpolate between minHz and peakHz
    const hz = minHz + speedMult * (peakHz - minHz);

    // Convert Hz to dt (ms between events)
    const dt = Math.round(1000 / hz);

    path.push({
      x: rawPoints[i].x,
      y: rawPoints[i].y,
      dt: Math.max(1, dt) // Minimum 1ms
    });
  }

  return path;
}

/**
 * Calculate total duration of a path in milliseconds.
 *
 * @param {Array<{dt: number}>} path - Path with timing data
 * @returns {number} Total duration in ms
 */
export function getPathDuration(path) {
  return path.reduce((sum, point) => sum + point.dt, 0);
}

/**
 * Get path statistics for debugging/logging.
 *
 * @param {Array<{x: number, y: number, dt: number}>} path
 * @returns {Object} Statistics
 */
export function getPathStats(path) {
  if (path.length < 2) {
    return { points: path.length, duration: 0, avgHz: 0, minHz: 0, maxHz: 0 };
  }

  const durations = path.map(p => p.dt);
  const totalDuration = durations.reduce((a, b) => a + b, 0);
  const avgDt = totalDuration / path.length;
  const minDt = Math.min(...durations);
  const maxDt = Math.max(...durations);

  // Calculate distance
  const startX = path[0].x;
  const startY = path[0].y;
  const endX = path[path.length - 1].x;
  const endY = path[path.length - 1].y;
  const distance = Math.round(Math.hypot(endX - startX, endY - startY));

  return {
    points: path.length,
    distance,
    duration: totalDuration,
    avgHz: Math.round(1000 / avgDt),
    minHz: Math.round(1000 / maxDt),
    maxHz: Math.round(1000 / minDt)
  };
}
