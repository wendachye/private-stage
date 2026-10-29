#!/bin/sh
set -eu

# Container deployments use a dedicated managed volume. Every writer of that
# volume must enter through this guard; never share it with a desktop process.
: "${DATA_DIR:?DATA_DIR must name the managed container data directory}"
case "$DATA_DIR" in
  /*) ;;
  *) echo 'Container DATA_DIR must be an absolute path.' >&2; exit 64 ;;
esac
mkdir -p -- "$DATA_DIR"

# Keep this inode permanently. flock is released by the kernel after a crash.
# --no-fork carries the held descriptor through sh and exec into Node, so a
# second container is refused before it can remove a lock or touch SQLite.
exec flock --exclusive --nonblock --conflict-exit-code 73 --no-fork \
  "$DATA_DIR/container.lock" \
  sh -eu -c '
    rm -f -- "$DATA_DIR/app.lock" "$DATA_DIR/app.lock.recover"
    exec "$@"
  ' private-stage-container "$@"
