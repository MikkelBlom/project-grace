import { registerTool } from '../registry.js';

registerTool({
  name: 'organize_files_by_extension',
  description: 'Moves files in a specified directory into subfolders named after their file extensions.',
  params: {
    root_path: { type: 'string', description: 'The absolute path of the directory to organize.', required: true },
  },
  async run(args: any, ctx: any) {
    const { root_path } = args;
    try {
      const listResult = await ctx.callTool('list_dir', { path: root_path });
      
      let files: any[] = [];
      if (Array.isArray(listResult)) {
        files = listResult;
      } else if (listResult && typeof listResult === 'object' && Array.isArray(listResult.files)) {
        files = listResult.files;
      } else if (listResult && typeof listResult === 'object' && Array.isArray(listResult.contents)) {
        files = listResult.contents;
      }

      if (files.length === 0 && !Array.isArray(listResult)) {
         // If it's not an array and doesn't have files/contents, it might be an error or empty
         if (typeof listResult === 'string' && listResult.includes('error')) {
            return { error: listResult };
         }
      }

      let movedCount = 0;
      const filesToMove = files.filter((f: any) => f.bytes > 0 && !f.name.startsWith('.'));

      const cleanRoot = root_path.replace(/[\\/]$/, '');

      for (const file of filesToMove) {
        const extension = file.name.split('.').pop()?.toLowerCase();
        if (!extension || file.name.includes('/') || file.name.includes('\\')) continue;

        const targetFolder = `${cleanRoot}/${extension}`;
        
        try {
          await ctx.callTool('create_folder', { path: targetFolder });
        } catch (err) {}

        const oldPath = `${cleanRoot}/${file.name}`;
        const newPath = `${targetFolder}/${file.name}`;

        try {
          await ctx.callTool('move_file', { from: oldPath, to: newPath });
          movedCount++;
        } catch (moveErr) {
          console.error(`Failed to move ${file.name}:`, moveErr);
        }
      }

      return { message: `Successfully organized ${movedCount} files into extension-based folders.` };
    } catch (error: any) {
      return { error: error.message };
    }
  }
});