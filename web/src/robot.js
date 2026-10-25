// Everything specific to the robot arm lives here. To swap arms, point this at a
// different MJCF and update the names below; the rest of the game reads only this.

export const ROBOT = {
  id: 'so101',
  name: 'SO-101',
  // Joint names match LeRobot's SO-101 so logged episodes line up with real-robot datasets.
  armJoints: ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex'],
  rollJoint: 'wrist_roll',
  gripperJoint: 'gripper',
  // Actuator order in the MJCF (position servos), used for ctrl.
  actuators: ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'],
  // End-effector site at the jaw tips. Its x axis points out of the gripper and the
  // jaws open along its z axis.
  eeSite: 'gripperframe',
  // The site sits right at the fixed jaw; aim a few mm toward the moving jaw so the
  // fixed jaw clears objects on the way down.
  graspOffset: [0, 0, 0.008],
  // World xy of the shoulder_pan axis; the reachable workspace is measured from it.
  panOrigin: [0.0388, 0.0],
  gripper: { open: 0.9, closed: -0.17, speed: 2.5 }, // rad and rad/s
  // Reachable box for the end-effector target, in the robot's frame (meters).
  workspace: { rMin: 0.08, rMax: 0.36, zMin: 0.005, zMax: 0.32 },
  // Defaults: gripper level (pitch 0) with the wrist camera on top (roll -90 deg), so the
  // jaws open sideways and close around objects from the side, a little farther out.
  defaultPitch: 0,
  defaultRoll: -Math.PI / 2,
};
