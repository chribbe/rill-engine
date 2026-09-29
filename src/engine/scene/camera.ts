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
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    this.forward = vec3.fromValues(sy * cp, sp, -cy * cp);
    this.right = vec3.fromValues(cy, 0, sy);
    const target = vec3.add(this.position, this.forward);
    this.view = mat4.lookAt(this.position, target, [0, 1, 0]);
    this.proj = mat4.perspectiveReverseZ(this.fovY, this.aspect, this.near, Infinity);
    this.viewProj = mat4.multiply(this.proj, this.view);
    this.invViewProj = mat4.inverse(this.viewProj);
  }

  /** Flat forward (for walking). */
  get flatForward(): Vec3 {
    return vec3.fromValues(Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }
}
