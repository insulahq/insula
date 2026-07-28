import { Loader2, CheckCircle, AlertCircle, Container, X } from 'lucide-react';
import { usePlatformImages } from '@/hooks/use-platform-images';

/**
 * Modal listing the container images + resolved tags currently running on the
 * cluster for platform-owned components. Sourced from the k8s API at request
 * time (the usePlatformImages hook only runs while the modal is mounted).
 */
export default function DeployedImagesModal({ onClose }: { readonly onClose: () => void }) {
  const { data, isLoading, isError } = usePlatformImages();
  const images = data?.data ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-xl bg-white dark:bg-gray-800 shadow-xl flex flex-col" data-testid="platform-images-modal">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <div className="flex items-center gap-2">
            <Container size={20} className="text-gray-600 dark:text-gray-400" />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Deployed Images</h2>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-200 transition-colors" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto p-5">
          {isLoading ? (
            <div className="flex items-center gap-2 py-8 justify-center"><Loader2 size={16} className="animate-spin text-gray-400" /><span className="text-sm text-gray-500 dark:text-gray-400">Loading image inventory…</span></div>
          ) : isError ? (
            <p className="text-sm text-red-600 dark:text-red-400">Failed to load image inventory.</p>
          ) : images.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">No images enumerated. The backend may lack cluster read permissions.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm" data-testid="platform-images-table">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
                    <th className="px-2 py-2 font-medium">Component</th>
                    <th className="px-2 py-2 font-medium">Namespace</th>
                    <th className="px-2 py-2 font-medium">Image</th>
                    <th className="px-2 py-2 font-medium">Tag</th>
                    <th className="px-2 py-2 font-medium text-right">Ready</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {images.map((row) => (
                    <tr key={`${row.namespace}/${row.component}/${row.image}`}>
                      <td className="px-2 py-2 text-gray-900 dark:text-gray-100 font-medium">{row.component}</td>
                      <td className="px-2 py-2 text-gray-600 dark:text-gray-400 font-mono text-xs">{row.namespace}</td>
                      <td className="px-2 py-2 text-gray-600 dark:text-gray-400 font-mono text-xs break-all">{row.image}</td>
                      <td className="px-2 py-2 text-gray-900 dark:text-gray-100 font-mono text-xs">{row.tag}</td>
                      <td className="px-2 py-2 text-right">
                        <span className={`inline-flex items-center gap-1 text-xs font-medium ${row.healthy ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'}`}>
                          {row.running}/{row.desired}
                          {row.healthy ? <CheckCircle size={12} /> : <AlertCircle size={12} />}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
