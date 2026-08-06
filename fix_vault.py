import os
import re
import sys

def organize_vault(vault_path):
    vault_path = os.path.abspath(os.path.expanduser(vault_path))

    # Verify directory exists
    if not os.path.exists(vault_path):
        print(f"\n[Error] The directory '{vault_path}' does not exist.")
        print("Please run the script with the actual path to your Obsidian vault.")
        return

    folders = ['Briefings', 'Coding', 'Reflections', 'Research']
    
    # 1. Ensure top-level folders & MOC files exist
    for folder in folders:
        folder_dir = os.path.join(vault_path, folder)
        os.makedirs(folder_dir, exist_ok=True)
        
        moc_file = os.path.join(vault_path, f"{folder} MOC.md")
        if not os.path.exists(moc_file):
            with open(moc_file, 'w') as f:
                f.write(f"# {folder} Map of Content\n\n## Linked Notes\n\n")
            print(f"Created: {folder} MOC.md")

    # 2. Process notes inside each directory
    for folder in folders:
        folder_path = os.path.join(vault_path, folder)
        moc_file = os.path.join(vault_path, f"{folder} MOC.md")
        toc_entries = []

        for root, _, files in os.walk(folder_path):
            for file in files:
                if not file.endswith('.md') or 'MOC' in file:
                    continue
                
                filepath = os.path.join(root, file)
                note_name = file[:-3] # Strip .md
                
                with open(filepath, 'r') as f:
                    content = f.read()

                # Inject category link at the top if missing
                category_tag = f"Category: [[{folder} MOC]]"
                if category_tag not in content:
                    date_match = re.search(r'\d{4}-\d{2}-\d{2}', file)
                    date_header = f"\nDate: [[{date_match.group(0)}]]" if date_match else ""
                    
                    header = f"---\n{category_tag}{date_header}\n---\n\n"
                    with open(filepath, 'w') as f:
                        f.write(header + content)
                    print(f"Updated headers: {file}")

                toc_entries.append(f"* [[{note_name}]]")

        # 3. Append links to MOC
        if toc_entries:
            with open(moc_file, 'w') as f:
                f.write(f"# {folder} Map of Content\n\n## Linked Notes\n\n" + "\n".join(toc_entries) + "\n")
            print(f"Indexed {len(toc_entries)} notes into {folder} MOC.md")

    print("\nVault reorganised and linked successfully!")

if __name__ == "__main__":
    if len(sys.argv) > 1:
        organize_vault(sys.argv[1])
    else:
        print("Usage: python3 fix_vault.py /path/to/ObsidianVault")
