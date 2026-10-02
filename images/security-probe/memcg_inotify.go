package main

// memcg_inotify.go — the event half of the OOM witness (memcg.go): one
// inotify instance watching each QoS directory for new pod cgroups, each pod
// cgroup for new container cgroups, its removal and every change to its
// memory.events, and each container cgroup's memory.events.

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

func (w *memcgWitness) openInotify() error {
	fd, err := unix.InotifyInit1(unix.IN_CLOEXEC | unix.IN_NONBLOCK)
	if err != nil {
		return err
	}
	// Non-blocking + os.NewFile puts the fd on Go's poller, so Close() wakes
	// the reader instead of leaving it parked in read(2).
	w.fd = fd
	w.notify = os.NewFile(uintptr(fd), "inotify")
	return nil
}

func (w *memcgWitness) addWatchLocked(path string, mask uint32) (int32, bool) {
	if w.fd < 0 {
		return 0, false
	}
	wd, err := unix.InotifyAddWatch(w.fd, path, mask)
	if err != nil {
		if errors.Is(err, unix.ENOSPC) {
			slog.Warn("memcg witness: inotify watch limit reached — relying on rescans", "path", path)
		}
		return 0, false
	}
	return int32(wd), true
}

func (w *memcgWitness) watchParentLocked(dir string) {
	if w.parentsOn[dir] {
		return
	}
	if wd, ok := w.addWatchLocked(dir, unix.IN_CREATE|unix.IN_MOVED_TO|unix.IN_ONLYDIR); ok {
		w.wdParent[wd] = dir
		w.parentsOn[dir] = true
	}
}

// watchPodLocked watches the pod directory (new container cgroups, its own
// removal) and its memory.events (every counter change).
func (w *memcgWitness) watchPodLocked(uid string, p *podMemcg) {
	if wd, ok := w.addWatchLocked(p.dir, unix.IN_CREATE|unix.IN_MOVED_TO|unix.IN_ONLYDIR|unix.IN_DELETE_SELF); ok {
		w.wdPod[wd] = uid
		p.wds[wd] = struct{}{}
	}
	if wd, ok := w.addWatchLocked(filepath.Join(p.dir, "memory.events"), unix.IN_MODIFY); ok {
		w.wdPod[wd] = uid
		p.wds[wd] = struct{}{}
		p.watched = true
	}
}

func (w *memcgWitness) readEvents(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("memcg witness: event loop panic — rescans only from now on", "recover", r)
		}
	}()
	buf := make([]byte, 64*1024)
	for {
		n, err := w.notify.Read(buf)
		if err != nil {
			if ctx.Err() == nil && !errors.Is(err, os.ErrClosed) && !errors.Is(err, io.EOF) {
				slog.Warn("memcg witness: inotify read failed — rescans only from now on", "err", err)
			}
			return
		}
		w.handleEvents(buf[:n])
	}
}

// handleEvents applies one batch of events, then reads each affected pod ONCE:
// an OOM storm raises many events per pod (every container and every
// ancestor cgroup), and a read per event would only slow the drain of a queue
// whose overflow is the witness's one blind spot.
func (w *memcgWitness) handleEvents(buf []byte) {
	w.mu.Lock()
	defer w.mu.Unlock()
	now := w.now()
	overflow := false
	dirty := map[string]struct{}{}
	for off := 0; off+unix.SizeofInotifyEvent <= len(buf); {
		ev := (*unix.InotifyEvent)(unsafe.Pointer(&buf[off]))
		nameLen := int(ev.Len)
		name := ""
		if nameLen > 0 && off+unix.SizeofInotifyEvent+nameLen <= len(buf) {
			raw := buf[off+unix.SizeofInotifyEvent : off+unix.SizeofInotifyEvent+nameLen]
			name = strings.TrimRight(string(raw), "\x00")
		}
		off += unix.SizeofInotifyEvent + nameLen
		w.handleEventLocked(ev.Wd, ev.Mask, name, now, &overflow, dirty)
	}
	for uid := range dirty {
		if p := w.pods[uid]; p != nil && p.removed.IsZero() {
			w.readPodLocked(uid, p, now)
		}
	}
	if overflow {
		// Events were dropped: re-read everything in the background, outside
		// this lock.
		go w.rescan()
	}
}

func (w *memcgWitness) handleEventLocked(
	wd int32, mask uint32, name string, now time.Time, overflow *bool, dirty map[string]struct{},
) {
	if mask&unix.IN_Q_OVERFLOW != 0 {
		*overflow = true
		w.overflows = append(w.overflows, now)
		if len(w.overflows) > memcgMaxOverflows {
			w.overflows = w.overflows[len(w.overflows)-memcgMaxOverflows:]
		}
		slog.Warn("memcg witness: inotify queue overflowed — events lost, rescanning")
		return
	}
	if parent, ok := w.wdParent[wd]; ok {
		if mask&unix.IN_IGNORED != 0 {
			delete(w.wdParent, wd)
			delete(w.parentsOn, parent)
			return
		}
		if mask&(unix.IN_CREATE|unix.IN_MOVED_TO) != 0 {
			if uid := podUIDFromDir(name); uid != "" {
				w.adoptLocked(uid, filepath.Join(parent, name), now)
			}
		}
		return
	}
	if ref, ok := w.wdScope[wd]; ok {
		if mask&unix.IN_IGNORED != 0 {
			// The container cgroup is gone; forget it without a further read.
			delete(w.wdScope, wd)
			if p := w.pods[ref.uid]; p != nil {
				if sc := p.scopes[ref.id]; sc != nil && sc.wd == wd {
					delete(p.scopes, ref.id)
				}
			}
			return
		}
		if mask&unix.IN_MODIFY != 0 {
			dirty[ref.uid] = struct{}{}
		}
		return
	}
	uid, ok := w.wdPod[wd]
	if !ok {
		return
	}
	p := w.pods[uid]
	if mask&unix.IN_IGNORED != 0 {
		delete(w.wdPod, wd)
		if p != nil {
			delete(p.wds, wd)
			if p.removed.IsZero() && !dirExists(p.dir) {
				p.removed = now
			}
		}
		return
	}
	if p == nil || !p.removed.IsZero() {
		return
	}
	if mask&unix.IN_DELETE_SELF != 0 {
		p.removed = now
		return
	}
	if mask&(unix.IN_CREATE|unix.IN_MOVED_TO) != 0 && name != "" {
		w.adoptScopeLocked(uid, p, name)
		return
	}
	if mask&unix.IN_MODIFY != 0 {
		dirty[uid] = struct{}{}
	}
}
