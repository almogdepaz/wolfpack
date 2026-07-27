#[test]
fn linked_ghostty_archive_does_not_corrupt_tokio_multithread_runtime() {
    for _ in 0..10 {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .expect("Tokio multithread runtime builds without linked static archive corruption");

        runtime.block_on(async {
            let mut handles = Vec::new();
            for seed in 0..32u8 {
                handles.push(tokio::task::spawn_blocking(move || {
                    let mut bytes = vec![0u8; 8192];
                    bytes.fill(seed);
                    bytes.iter().map(|byte| u64::from(*byte)).sum::<u64>()
                }));
            }
            for handle in handles {
                handle.await.expect("blocking task joins");
            }
        });
    }
}
