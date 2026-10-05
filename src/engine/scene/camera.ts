import { mat4, vec3, type Mat4, type Vec3 } from 'wgpu-matrix';

/**
 * First-person camera. Right-handed, Y-up, metres. -Z is north, +X east.
 * Reverse-Z infinite projection: depth precision is highest far away, which is
 * where long urban sightlines need it.
 */
export class Camera {
  position: Vec3 = vec3.fromValues(0, 1.7, 0);
  yaw = 0; // radians, 0 = looking north (-Z), positive = turning right (clockwise from above)
  pitch = 0;
  /** Roll (radians, positive = right side down), e.g. strafe lean. */
  roll = 0;
  /**
   * Additive view rotation (pitch, yaw, roll radians) on top of yaw/pitch/roll:
   * recoil and other kicks. Rendering and `forward` include it; yaw/pitch stay
   * the player's own aim.
   */
  punch: Vec3 = vec3.fromValues(0, 0, 0);
  fovY = (62 * Math.PI) / 180;
  near = 0.05;
  aspect = 16 / 9;

  view: Mat4 = mat4.identity();
  proj: Mat4 = mat4.identity();
  viewProj: Mat4 = mat4.identity();
  invViewProj: Mat4 = mat4.identity();
  forward: Vec3 = vec3.fromValues(0, 0, -1);
  right: Vec3 = vec3.fromValues(1, 0, 0);

  update() {
    const pitch = Math.max(-1.56, Math.min(1.56, this.pitch + this.punch[0]));
    const yaw = this.yaw + this.punch[1], roll = this.roll + this.punch[2];
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    this.forward = vec3.fromValues(sy * cp, sp, -cy * cp);
    this.right = vec3.fromValues(cy, 0, sy);
    let up: ArrayLike<number> = [0, 1, 0];
    if (roll !== 0) {
      // Rolled up vector: unrolled up (right x forward) turned towards right.
      const u = vec3.cross(this.right, this.forward);
      const cr = Math.cos(roll), sr = Math.sin(roll);
      up = [u[0] * cr + this.right[0] * sr, u[1] * cr + this.right[1] * sr, u[2] * cr + this.right[2] * sr];
      this.right = vec3.fromValues(this.right[0] * cr - u[0] * sr, this.right[1] * cr - u[1] * sr, this.right[2] * cr - u[2] * sr);
    }
    const target = vec3.add(this.position, this.forward);
    this.view = mat4.lookAt(this.position, target, up);
    this.proj = mat4.perspectiveReverseZ(this.fovY, this.aspect, this.near, Infinity);
    this.viewProj = mat4.multiply(this.proj, this.view);
    this.invViewProj = mat4.inverse(this.viewProj);
  }

  /** Flat forward (for walking). */
  get flatForward(): Vec3 {
    return vec3.fromValues(Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }
}
