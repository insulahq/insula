// Package modsecurity is a Traefik middleware plugin that asks an OWASP
// ModSecurity-CRS container for a verdict on every request before passing it
// on. A verdict of 300 or above (a block, or ModSecurity's `redirect` action) is
// returned to the client as-is; a 2xx lets the request through to the next
// handler; a 5xx or no answer fails closed with 502.
//
// Derived from github.com/madebymode/traefik-modsecurity-plugin v1.6.0
// (Apache License 2.0) and modified by the Insula project. NOTICE lists every
// change; README.md explains why the platform carries its own copy.
//
// Traefik runs this file in its Yaegi interpreter, not as compiled Go: keep to
// the standard library and plain constructs (no generics, no cgo, no unsafe).
// The CI job runs the tests under both `go test` and `yaegi test`.
package modsecurity

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultTimeoutMillis     = 2000
	defaultBodyTimeoutMillis = 10000
	// ModSecurity's own default SecRequestBodyLimit. A larger body would be
	// rejected by the sidecar anyway, so refusing it here loses no coverage.
	defaultMaxBodyBytes        = 13107200
	defaultMemBodyBytes        = 65536
	defaultMaxIdleConnsPerHost = 64
	// The sidecar's verdict page is small; never copy more than this of it.
	maxVerdictBodyBytes = 1 << 20
)

// Config the plugin configuration. Keys are matched case-insensitively by
// Traefik; keys this struct does not have (e.g. the upstream jail* settings)
// are dropped silently.
type Config struct {
	// ModSecurityURL is where verdict requests go; the original request URI is
	// appended to it.
	ModSecurityURL string `json:"modSecurityUrl,omitempty"`
	// TimeoutMillis bounds the wait for the verdict once the request, body
	// included, has been sent to the sidecar.
	TimeoutMillis int64 `json:"timeoutMillis,omitempty"`
	// BodyTimeoutMillis bounds sending the request body to the sidecar, on top
	// of TimeoutMillis. Kept apart so a large upload cannot eat the verdict
	// budget.
	BodyTimeoutMillis int64 `json:"bodyTimeoutMillis,omitempty"`
	// MaxBodyBytes is the largest request body accepted; larger ones get 413
	// without contacting the sidecar.
	MaxBodyBytes int64 `json:"maxBodyBytes,omitempty"`
	// MemBodyBytes is how much of a body is held in memory; the rest of a larger
	// body is written to a temporary file in SpoolDir.
	MemBodyBytes int64 `json:"memBodyBytes,omitempty"`
	// SpoolDir holds temporary body files; empty means os.TempDir().
	SpoolDir string `json:"spoolDir,omitempty"`
	// MaxConnsPerHost caps connections to the sidecar (0 = no cap).
	MaxConnsPerHost int `json:"maxConnsPerHost,omitempty"`
	// MaxIdleConnsPerHost is the idle connection pool to the sidecar.
	MaxIdleConnsPerHost int `json:"maxIdleConnsPerHost,omitempty"`
	// UnhealthyWafBackOffPeriodSecs, when > 0, lets requests through
	// UNINSPECTED for this many seconds after the sidecar fails. 0 (default)
	// answers 502 instead: a WAF that an attacker can switch off by overloading
	// it is not a WAF.
	UnhealthyWafBackOffPeriodSecs int `json:"unhealthyWafBackOffPeriodSecs,omitempty"`
	// ModSecurityStatusRequestHeader, when set, names a request header that
	// records the outcome (a status code, "unhealthy" or "error") so access
	// logs can show it.
	ModSecurityStatusRequestHeader string `json:"modSecurityStatusRequestHeader,omitempty"`
}

// CreateConfig creates the default plugin configuration.
func CreateConfig() *Config {
	return &Config{
		TimeoutMillis:       defaultTimeoutMillis,
		BodyTimeoutMillis:   defaultBodyTimeoutMillis,
		MaxBodyBytes:        defaultMaxBodyBytes,
		MemBodyBytes:        defaultMemBodyBytes,
		MaxIdleConnsPerHost: defaultMaxIdleConnsPerHost,
	}
}

// Modsecurity a Modsecurity plugin.
type Modsecurity struct {
	next          http.Handler
	name          string
	modSecurity   string
	transport     *http.Transport
	timeout       time.Duration
	bodyTimeout   time.Duration
	maxBodyBytes  int64
	memBodyBytes  int64
	spoolDir      string
	backOffPeriod time.Duration
	statusHeader  string
	logger        *log.Logger

	mu             sync.Mutex
	unhealthyUntil time.Time
}

var (
	errBodyTooLarge = errors.New("request body exceeds maxBodyBytes")
	errVerdictDone  = errors.New("verdict exchange finished")
	// errSpool marks a failure of this pod's own disk, not of the client.
	errSpool = errors.New("spooling the request body")
)

// hopHeaders are meaningful only on one connection and are never part of the
// verdict request: `Upgrade` in particular would make the sidecar request an
// upgrade attempt of its own.
var hopHeaders = []string{
	"Connection", "Expect", "Keep-Alive", "Proxy-Connection", "Te", "Trailer",
	"Transfer-Encoding", "Upgrade",
}

// Every middleware instance runs in the same interpreter, so sidecar
// connections are pooled per distinct transport setting rather than per
// router: a cluster with hundreds of WAF routes keeps one pool.
var (
	transportsMu sync.Mutex
	transports   = map[string]*http.Transport{}
)

func sharedTransport(timeout time.Duration, maxConns, maxIdle int) *http.Transport {
	key := fmt.Sprintf("%d/%d/%d", timeout, maxConns, maxIdle)
	transportsMu.Lock()
	defer transportsMu.Unlock()
	if t, ok := transports[key]; ok {
		return t
	}
	dialer := &net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second}
	t := &http.Transport{
		// A closure, not the method value dialer.DialContext: Yaegi cannot
		// convert a method value of a compiled type to a func field.
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return dialer.DialContext(ctx, network, addr)
		},
		MaxIdleConns:          maxIdle,
		MaxIdleConnsPerHost:   maxIdle,
		MaxConnsPerHost:       maxConns,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: timeout,
		TLSHandshakeTimeout:   timeout,
	}
	transports[key] = t
	return t
}

// New creates a new Modsecurity plugin with the given configuration.
func New(_ context.Context, next http.Handler, config *Config, name string) (http.Handler, error) {
	target := strings.TrimRight(config.ModSecurityURL, "/")
	if target == "" {
		return nil, fmt.Errorf("modSecurityUrl cannot be empty")
	}
	u, err := url.Parse(target)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("modSecurityUrl %q is not an http(s) URL with a host", config.ModSecurityURL)
	}
	if config.TimeoutMillis <= 0 || config.BodyTimeoutMillis <= 0 {
		return nil, fmt.Errorf("timeoutMillis and bodyTimeoutMillis must be positive")
	}
	if config.MaxBodyBytes <= 0 {
		return nil, fmt.Errorf("maxBodyBytes must be positive")
	}
	if config.MemBodyBytes < 0 || config.MemBodyBytes > config.MaxBodyBytes {
		return nil, fmt.Errorf("memBodyBytes must be between 0 and maxBodyBytes")
	}
	if config.MaxConnsPerHost < 0 || config.MaxIdleConnsPerHost < 0 || config.UnhealthyWafBackOffPeriodSecs < 0 {
		return nil, fmt.Errorf("connection limits and unhealthyWafBackOffPeriodSecs cannot be negative")
	}

	timeout := time.Duration(config.TimeoutMillis) * time.Millisecond
	return &Modsecurity{
		next:        next,
		name:        name,
		modSecurity: target,
		// The transport, not an http.Client: RoundTrip never follows redirects
		// (a redirect is the verdict — following it would let whatever answers
		// it decide), and Client.CheckRedirect, the alternative, is a callback
		// Yaegi cannot hand to compiled net/http (measured: panic on a 3xx).
		transport:     sharedTransport(timeout, config.MaxConnsPerHost, config.MaxIdleConnsPerHost),
		timeout:       timeout,
		bodyTimeout:   time.Duration(config.BodyTimeoutMillis) * time.Millisecond,
		maxBodyBytes:  config.MaxBodyBytes,
		memBodyBytes:  config.MemBodyBytes,
		spoolDir:      config.SpoolDir,
		backOffPeriod: time.Duration(config.UnhealthyWafBackOffPeriodSecs) * time.Second,
		statusHeader:  config.ModSecurityStatusRequestHeader,
		logger:        log.New(os.Stdout, "", log.LstdFlags),
	}, nil
}

// ServeHTTP inspects EVERY request. Upstream skipped any request carrying
// `Upgrade: websocket`, whatever its method or body, which let a single header
// take any request past the WAF.
func (m *Modsecurity) ServeHTTP(rw http.ResponseWriter, req *http.Request) {
	if m.backingOff() {
		m.mark(req, "unhealthy")
		m.next.ServeHTTP(rw, req)
		return
	}

	body, err := m.readBody(req)
	if err != nil {
		if errors.Is(err, errBodyTooLarge) {
			http.Error(rw, http.StatusText(http.StatusRequestEntityTooLarge), http.StatusRequestEntityTooLarge)
			return
		}
		m.logger.Printf("modsecurity[%s]: reading request body: %v", m.name, err)
		if errors.Is(err, errSpool) {
			http.Error(rw, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
			return
		}
		http.Error(rw, http.StatusText(http.StatusBadRequest), http.StatusBadRequest)
		return
	}
	defer body.Close()

	ctx, cancel := context.WithTimeout(req.Context(), m.timeout+m.bodyTimeout)
	verdict, err := m.ask(ctx, req, body)
	if err == nil && verdict.StatusCode >= http.StatusInternalServerError {
		// The sidecar's own failure (its stub backend down, say), not a block.
		_ = verdict.Body.Close()
		err = fmt.Errorf("sidecar answered %d", verdict.StatusCode)
	}
	if err != nil {
		cancel()
		m.logger.Printf("modsecurity[%s]: no verdict: %v", m.name, withoutURL(err))
		if m.startBackOff() {
			m.mark(req, "error")
			m.forward(rw, req, body)
			return
		}
		http.Error(rw, http.StatusText(http.StatusBadGateway), http.StatusBadGateway)
		return
	}

	// 3xx counts as a decision too: ModSecurity's `redirect` action answers
	// with one, and passing such a request on would undo it.
	if verdict.StatusCode >= http.StatusMultipleChoices {
		m.mark(req, strconv.Itoa(verdict.StatusCode))
		forwardResponse(verdict, rw)
		_ = verdict.Body.Close()
		cancel()
		return
	}
	// Close the verdict UNREAD before the backend call. Draining it for
	// connection reuse looked free and was not: the sidecar proxies to a stub
	// whose response to a large upload can stall, and reading it then waited
	// out the whole deadline — measured with the platform's ModSecurity-CRS
	// image and whoami stub: every 1 MiB multipart upload took 13 s. An unread
	// close costs one new sidecar connection per request, as upstream did.
	_ = verdict.Body.Close()
	cancel()
	m.mark(req, strconv.Itoa(verdict.StatusCode))
	m.forward(rw, req, body)
}

// withoutURL drops the URL net/http wraps around transport errors: it carries
// the client's request URI, query string and all, which has no place in a log.
func withoutURL(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return fmt.Errorf("%s: %w", ue.Op, ue.Err)
	}
	return err
}

// ask sends the request — method, URI, headers and body — to the sidecar.
func (m *Modsecurity) ask(ctx context.Context, req *http.Request, body *requestBody) (*http.Response, error) {
	src, release := body.open()
	proxyReq, err := http.NewRequestWithContext(ctx, req.Method, m.modSecurity+requestURI(req), src)
	if err != nil {
		release()
		return nil, err
	}
	proxyReq.ContentLength = body.size
	proxyReq.Header = sidecarHeaders(req)
	// Host stays the sidecar's, as upstream had it: Traefik only routed this
	// request here because Host matched the route's domain, and the platform's
	// exclusion rules and WAF event log key on X-Forwarded-Host, which carries
	// the client's value. Sending Host itself would newly arm CRS's Host rules
	// (an IP literal, say) on every route at once.
	resp, err := m.transport.RoundTrip(proxyReq)
	release()
	return resp, err
}

// forward hands the request, its body replayed from the start, to the next
// handler.
func (m *Modsecurity) forward(rw http.ResponseWriter, req *http.Request, body *requestBody) {
	switch {
	case body.buffered != nil:
		// req.Body still wraps the buffer; rewinding it is the whole replay.
		if _, err := body.buffered.Seek(0, io.SeekStart); err != nil {
			m.logger.Printf("modsecurity[%s]: rewinding the buffered body: %v", m.name, err)
			http.Error(rw, http.StatusText(http.StatusBadGateway), http.StatusBadGateway)
			return
		}
	case body.size > 0:
		req.Body = io.NopCloser(body.reader())
		req.ContentLength = body.size
		req.TransferEncoding = nil
	}
	m.next.ServeHTTP(rw, req)
}

// requestURI is the URI as the client sent it, always in origin form
// ("/path?query"). An absolute-form target ("GET http://host/path") or "*"
// would otherwise be glued onto the sidecar URL as a different host.
//
// A raw '#' is escaped. Go's server does not treat it as a fragment — it stays
// in the path or query, and Traefik forwards it to the backend — but parsing
// the verdict URL would cut everything after it off, so the WAF would judge
// `/?id=1` while the backend ran `/?id=1#<payload>` (measured on Traefik
// v3.7.6; upstream has the same hole). ModSecurity decodes %23 back.
func requestURI(req *http.Request) string {
	uri := req.RequestURI
	if !strings.HasPrefix(uri, "/") {
		uri = req.URL.RequestURI()
		if !strings.HasPrefix(uri, "/") {
			uri = "/" + uri
		}
	}
	return strings.ReplaceAll(uri, "#", "%23")
}

// sidecarHeaders is the request's header minus hop-by-hop fields, with the
// client address appended to X-Forwarded-For. Traefik adds that only when it
// proxies, i.e. after this middleware, so without it ModSecurity would log the
// Traefik pod as the client.
func sidecarHeaders(req *http.Request) http.Header {
	h := req.Header.Clone()
	if h == nil {
		h = http.Header{}
	}
	for _, k := range hopHeaders {
		h.Del(k)
	}
	if ip := clientIP(req.RemoteAddr); ip != "" {
		if prior := h.Values("X-Forwarded-For"); len(prior) > 0 {
			h.Set("X-Forwarded-For", strings.Join(prior, ", ")+", "+ip)
		} else {
			h.Set("X-Forwarded-For", ip)
		}
	}
	return h
}

func clientIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return ""
	}
	return host
}

// forwardResponse writes the sidecar's verdict to the client. Headers replace
// whatever earlier middlewares set on the same names rather than being added
// next to them.
func forwardResponse(resp *http.Response, rw http.ResponseWriter) {
	dst := rw.Header()
	for k, vv := range resp.Header {
		if isHopHeader(k) {
			continue
		}
		dst[k] = append([]string(nil), vv...)
	}
	rw.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(rw, io.LimitReader(resp.Body, maxVerdictBodyBytes))
}

func isHopHeader(name string) bool {
	for _, h := range hopHeaders {
		if strings.EqualFold(h, name) {
			return true
		}
	}
	return false
}

// mark records the outcome in the configured status header. Every path sets it,
// so a value the client sent itself never survives into the access log.
func (m *Modsecurity) mark(req *http.Request, outcome string) {
	if m.statusHeader != "" {
		req.Header.Set(m.statusHeader, outcome)
	}
}

func (m *Modsecurity) backingOff() bool {
	if m.backOffPeriod <= 0 {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return time.Now().Before(m.unhealthyUntil)
}

// startBackOff reports whether the request should pass uninspected because
// back-off is enabled, and opens the window if it is not open yet.
func (m *Modsecurity) startBackOff() bool {
	if m.backOffPeriod <= 0 {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if !time.Now().Before(m.unhealthyUntil) {
		m.unhealthyUntil = time.Now().Add(m.backOffPeriod)
		m.logger.Printf("modsecurity[%s]: sidecar unhealthy, passing requests UNINSPECTED for %s", m.name, m.backOffPeriod)
	}
	return true
}

// requestBody is a request body that has to be read twice: once by the
// sidecar, once by the backend. It is never held whole in memory:
//   - behind `waf-body-limit` (the platform's route builders always chain it
//     right before this middleware) Traefik has already buffered the body
//     replayably, and that buffer is reused;
//   - otherwise up to memBodyBytes stay in memory and the rest of a larger body
//     goes to an already-unlinked temporary file, so a crash leaves nothing
//     behind and the disk space returns when the descriptor closes.
type requestBody struct {
	size     int64
	buffered io.ReadSeeker
	mem      []byte
	file     *os.File
}

// readBody reads the request body under the size cap. Upstream read it whole
// with io.ReadAll, so every body up to the cap sat in Traefik's heap for the
// whole request, including however long the backend took to answer — on top
// of the copy `waf-body-limit` had already made.
func (m *Modsecurity) readBody(req *http.Request) (*requestBody, error) {
	// ContentLength 0 means no body for both HTTP/1.1 and HTTP/2. Not
	// `req.Body == http.NoBody`: Yaegi panics comparing an interface that holds
	// an interpreted type.
	if req.Body == nil || req.ContentLength == 0 {
		return &requestBody{}, nil
	}
	if req.ContentLength > m.maxBodyBytes {
		return nil, errBodyTooLarge
	}
	if req.ContentLength < 0 {
		return m.spool(req)
	}
	if b := bufferedBody(req); b != nil {
		return &requestBody{size: req.ContentLength, buffered: b}, nil
	}
	return m.spool(req)
}

// reusableBuffers names the buffer types bufferedBody may rewind and reuse:
// oxy's (mailgun/multibuf), which Traefik's buffering middleware puts behind
// req.Body. A Traefik upgrade that changes the type only costs the reuse — the
// body is spooled instead. Tests add their stand-in.
var reusableBuffers = map[string]bool{"*multibuf.multiReaderSeek": true}

// bufferedBody returns the replayable buffer behind req.Body, or nil. oxy hands
// the request on with `Body: io.NopCloser(multibuf)`; NopCloser's struct keeps
// the reader in its exported embedded field `Reader`, and multibuf rewinds with
// Seek(0, io.SeekStart). oxy sets ContentLength from the same buffer, and the
// transports refuse a body whose length disagrees with it, so a mismatch fails
// closed rather than replaying the wrong bytes.
//
// Reflection only ever touches req.Body, a compiled value. Under Yaegi,
// reflecting on an interface held in an interpreted variable, or asserting a
// compiled value to an interface declared here, misbehaves (measured on
// Traefik v3.7.6: a panic on every request, and an assertion that failed
// although the method existed).
func bufferedBody(req *http.Request) (found io.ReadSeeker) {
	// Reflection is where Yaegi has panicked before. If an interpreted
	// middleware ever wraps req.Body, fall back to spooling instead of failing
	// every request on every WAF route.
	defer func() {
		if recover() != nil {
			found = nil
		}
	}()
	v := reflect.ValueOf(req.Body)
	if v.Kind() != reflect.Struct {
		return nil
	}
	f := v.FieldByName("Reader")
	if !f.IsValid() || f.Kind() != reflect.Interface || f.IsNil() || !f.CanInterface() {
		return nil
	}
	if !reusableBuffers[f.Elem().Type().String()] {
		return nil
	}
	b, ok := f.Interface().(io.ReadSeeker)
	if !ok {
		return nil
	}
	if _, err := b.Seek(0, io.SeekStart); err != nil {
		return nil
	}
	return b
}

func (m *Modsecurity) spool(req *http.Request) (*requestBody, error) {
	limited := io.LimitReader(req.Body, m.maxBodyBytes+1)

	head, err := io.ReadAll(io.LimitReader(limited, m.memBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if len(head) == 0 {
		// Nothing was sent; leave the (drained) body and its framing alone.
		return &requestBody{}, nil
	}
	if int64(len(head)) <= m.memBodyBytes {
		return &requestBody{mem: head, size: int64(len(head))}, nil
	}

	f, err := os.CreateTemp(m.spoolDir, "modsecurity-body-")
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errSpool, err)
	}
	// Unlinked while open: the data stays readable through f until Close.
	_ = os.Remove(f.Name())
	body := &requestBody{file: f}
	if _, err := f.Write(head); err != nil {
		body.Close()
		return nil, fmt.Errorf("%w: %v", errSpool, err)
	}
	rest, err := io.Copy(f, limited)
	if err != nil {
		body.Close()
		return nil, err
	}
	body.size = int64(len(head)) + rest
	if body.size > m.maxBodyBytes {
		body.Close()
		return nil, errBodyTooLarge
	}
	return body, nil
}

// reader returns an independent reader over a spooled or in-memory body. Each
// call starts at offset 0 and file reads use ReadAt, so the transport may still
// be finishing with the sidecar's copy while the backend reads its own.
func (b *requestBody) reader() io.Reader {
	if b.file != nil {
		return io.NewSectionReader(b.file, 0, b.size)
	}
	if len(b.mem) == 0 {
		return http.NoBody
	}
	return bytes.NewReader(b.mem)
}

// open returns the body for the verdict request and a release func that must
// run once the exchange is over. A reused buffer has one read position shared
// with the backend's replay, and net/http may still read a request body after
// the response has arrived. So the transport never gets the buffer itself: a
// goroutine of ours copies it into a pipe, and release closes the pipe and
// waits for that goroutine. After release nothing but the caller touches the
// buffer.
func (b *requestBody) open() (io.Reader, func()) {
	if b.buffered == nil {
		return b.reader(), func() {}
	}
	pr, pw := io.Pipe()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, err := io.Copy(pw, io.LimitReader(b.buffered, b.size))
		_ = pw.CloseWithError(err)
	}()
	return pr, func() {
		_ = pr.CloseWithError(errVerdictDone)
		<-done
	}
}

// Close releases the spool file, if any. A reused buffer belongs to
// `waf-body-limit`, which closes it.
func (b *requestBody) Close() {
	if b.file != nil {
		_ = b.file.Close()
	}
}
