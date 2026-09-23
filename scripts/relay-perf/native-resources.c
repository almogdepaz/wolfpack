// macOS libproc counters: bytes and cumulative nanoseconds, never parsed ps prose.
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>

int main(int argc, char **argv) {
  if (argc < 2) return 64;
  mach_timebase_info_data_t timebase;
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || !timebase.denom) return 1;
  for (int i = 1; i < argc; i++) {
    char *end;
    errno = 0;
    long pid = strtol(argv[i], &end, 10);
    if (errno || *end || end == argv[i] || pid <= 0 || pid > INT_MAX) return 64;
    struct proc_bsdinfo identity = {0};
    struct rusage_info_v2 usage = {0};
    if (proc_pidinfo((int)pid, PROC_PIDTBSDINFO, 0, &identity, sizeof(identity)) != sizeof(identity)
        || proc_pid_rusage((int)pid, RUSAGE_INFO_V2, (rusage_info_t *)&usage) != 0) {
      fprintf(stderr, "libproc failed for pid %ld: errno=%d\n", pid, errno);
      return 1;
    }
    // rusage_info CPU times are Mach absolute ticks, not nanoseconds on arm64.
    uint64_t cpu_ns = (uint64_t)(((__uint128_t)usage.ri_user_time + usage.ri_system_time)
                              * timebase.numer / timebase.denom);
    printf("{\"pid\":%ld,\"parentPid\":%u,\"startSeconds\":%" PRIu64
           ",\"startMicros\":%" PRIu64 ",\"rss\":%" PRIu64 ",\"cpuNanos\":%" PRIu64 "}\n",
           pid, identity.pbi_ppid, identity.pbi_start_tvsec, identity.pbi_start_tvusec,
           usage.ri_resident_size, cpu_ns);
  }
  return ferror(stdout) ? 1 : 0;
}
